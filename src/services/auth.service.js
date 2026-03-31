import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

const DEMO_OTP = '1234';

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

export function verifyOtp(otp) {
  return String(otp) === DEMO_OTP;
}

export async function verifyOtpAndLogin(mobile, otp) {
  if (!verifyOtp(otp)) {
    const err = new Error('Invalid OTP');
    err.statusCode = 400;
    throw err;
  }
  const user = await findOrCreateUserByMobile(mobile);
  const token = issueToken(user.id);
  return { user, token };
}
