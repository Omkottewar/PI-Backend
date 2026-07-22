import jwt from 'jsonwebtoken';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

// 10 minutes to match the DLT-approved LOGIN_OTP template body
// ("It is valid for 10 minutes"). Changing this without re-registering
// the template on DLT would leave users staring at "OTP expired" between
// minutes 5-10 while the SMS promised 10.
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export async function findOrCreateUserByMobile(mobile) {
  const existing = await pool.query('SELECT * FROM users WHERE mobile = $1', [mobile]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await pool.query(
    `INSERT INTO users (mobile) VALUES ($1) RETURNING *`,
    [mobile]
  );
  return inserted.rows[0];
}

export function issueToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// Per-record salt makes rainbow tables useless despite the tiny 10k code
// space. We're not using bcrypt here — the throughput cost isn't worth
// it when rate limiting + attempt cap already bound the attacker.
function hashOtp(otp, salt) {
  return createHash('sha256').update(String(salt) + String(otp)).digest('hex');
}

// Cheap idempotency guard so a fresh deploy that hasn't run migrations
// yet still works. Migration 019 also creates this schema; keeping it
// here means we never 500 with "relation login_otp does not exist" while
// waiting on `npm run migrate` to fire on Render.
let _loginOtpEnsured = false;
async function ensureLoginOtpTable(client) {
  if (_loginOtpEnsured) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS login_otp (
      id           SERIAL PRIMARY KEY,
      mobile       VARCHAR(20) NOT NULL,
      otp_hash     TEXT        NOT NULL,
      salt         TEXT        NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      attempts     INT         NOT NULL DEFAULT 0,
      used_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS login_otp_mobile_idx ON login_otp(mobile);`);
  await client.query(`CREATE INDEX IF NOT EXISTS login_otp_expires_idx ON login_otp(expires_at);`);
  _loginOtpEnsured = true;
}

// Generates a 4-digit OTP, invalidates any prior codes for this mobile,
// and persists a fresh salted-hash row with a 10-minute TTL. Returns the
// PLAIN-TEXT OTP so the caller can pipe it to the SMS transport — never
// log this or return it to a client.
export async function issueLoginOtp(mobile) {
  const client = await pool.connect();
  try {
    await ensureLoginOtpTable(client);
    await client.query('BEGIN');
    // Any outstanding unused OTPs for this mobile are marked as consumed
    // so only the newest code can be redeemed. Prevents a stale code
    // from working when the user re-requests.
    await client.query(
      `UPDATE login_otp
          SET used_at = NOW()
        WHERE mobile = $1 AND used_at IS NULL`,
      [mobile]
    );
    const otp = String(randomInt(0, 10000)).padStart(4, '0');
    const salt = randomBytes(16).toString('hex');
    const hash = hashOtp(otp, salt);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    await client.query(
      `INSERT INTO login_otp (mobile, otp_hash, salt, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [mobile, hash, salt, expiresAt]
    );
    await client.query('COMMIT');
    return otp;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Constant-time comparison so an attacker can't infer partial matches
// from response timing. Both inputs are hex-encoded hashes, same length.
function safeHexEquals(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function verifyOtpAndLogin(mobile, otp) {
  const otpStr = String(otp || '').trim();
  if (!/^\d{4}$/.test(otpStr)) {
    const err = new Error('OTP must be 4 digits');
    err.statusCode = 400;
    throw err;
  }

  // Static-OTP escape hatch — active when config.devStaticOtp is a
  // non-empty string. Skips the DB round trip entirely so it works even
  // when no login_otp row was ever created (e.g., someone testing
  // against a fresh account without hitting /auth/login first).
  if (config.devStaticOtp && otpStr === config.devStaticOtp) {
    console.warn(`[auth] static-OTP login accepted for mobile=${mobile}`);
    const user = await findOrCreateUserByMobile(mobile);
    const token = issueToken(user.id);
    return { user, token };
  }

  // Grab the most recent unused OTP for this mobile. Older ones were
  // already marked used by issueLoginOtp, so at most one row can win.
  const row = await pool.query(
    `SELECT id, otp_hash, salt, expires_at, attempts
       FROM login_otp
      WHERE mobile = $1 AND used_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [mobile]
  );
  if (!row.rows.length) {
    const err = new Error('No active OTP — please request a new code');
    err.statusCode = 400;
    throw err;
  }
  const record = row.rows[0];
  if (new Date(record.expires_at).getTime() < Date.now()) {
    // Mark it used so a repeat attempt hits "no active OTP" instead of
    // "expired" — same UX, avoids leaking whether an OTP ever existed.
    await pool.query(`UPDATE login_otp SET used_at = NOW() WHERE id = $1`, [record.id]);
    const err = new Error('OTP expired — please request a new code');
    err.statusCode = 400;
    throw err;
  }

  const expectedHash = hashOtp(otpStr, record.salt);
  const ok = safeHexEquals(expectedHash, record.otp_hash);

  if (!ok) {
    // Consume one attempt. Past MAX_ATTEMPTS the row is invalidated so
    // the attacker can't just spam the same session with all 10k codes.
    const newAttempts = record.attempts + 1;
    if (newAttempts >= MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE login_otp SET attempts = $2, used_at = NOW() WHERE id = $1`,
        [record.id, newAttempts]
      );
      const err = new Error('Too many wrong attempts — request a new OTP');
      err.statusCode = 400;
      throw err;
    }
    await pool.query(
      `UPDATE login_otp SET attempts = $2 WHERE id = $1`,
      [record.id, newAttempts]
    );
    const err = new Error('Invalid OTP');
    err.statusCode = 400;
    throw err;
  }

  await pool.query(
    `UPDATE login_otp SET used_at = NOW() WHERE id = $1`,
    [record.id]
  );

  const user = await findOrCreateUserByMobile(mobile);
  const token = issueToken(user.id);
  return { user, token };
}
