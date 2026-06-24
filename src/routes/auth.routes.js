import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { verifyOtpAndLogin } from '../services/auth.service.js';
import { databaseErrorResponse } from '../utils/dbErrors.js';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';

const router = Router();

router.post(
  '/login',
  body('mobile').trim().isLength({ min: 10, max: 15 }).withMessage('Valid mobile required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    return res.json({ message: 'OTP sent (demo: use 1234)' });
  }
);

router.post(
  '/verify-otp',
  body('mobile').trim().isLength({ min: 10, max: 15 }),
  body('otp').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      // Demo OTP 1234; creates user row on first login if mobile is new
      const { user, token } = await verifyOtpAndLogin(req.body.mobile, req.body.otp);
      return res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          mobile: user.mobile,
          email: user.email,
          age: user.age,
          address: user.address,
          created_at: user.created_at,
        },
      });
    } catch (e) {
      const db = databaseErrorResponse(e);
      if (db) {
        return res.status(db.status).json({ error: db.error, hint: db.hint });
      }
      const code = e.statusCode || 500;
      return res.status(code).json({ error: e.message });
    }
  }
);

router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, mobile, email, age, address, manual_user, created_at
         FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: r.rows[0] });
  } catch (e) {
    const db = databaseErrorResponse(e);
    if (db) return res.status(db.status).json({ error: db.error, hint: db.hint });
    return res.status(500).json({ error: e.message });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  // JWT is stateless — clients drop the token. This endpoint exists so the
  // client always has a server hook to call on logout (telemetry, future
  // token revocation table, etc.). Returns 200 even if the token was already
  // expired so the client can finish cleanup either way.
  return res.json({ success: true });
});

export default router;
