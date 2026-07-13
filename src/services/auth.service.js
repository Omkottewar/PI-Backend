import jwt from 'jsonwebtoken';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

const OTP_TTL_MINUTES = 5;
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

// Generates a 4-digit OTP, invalidates any prior codes for this mobile,
// and persists a fresh salted-hash row with a 5-minute TTL. Returns the
// PLAIN-TEXT OTP so the caller can pipe it to the SMS transport — never
// log this or return it to a client.
export async function issueLoginOtp(mobile) {
  const client = await pool.connect();
  try {
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
