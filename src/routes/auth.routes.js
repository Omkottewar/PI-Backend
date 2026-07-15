import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { verifyOtpAndLogin, issueLoginOtp } from '../services/auth.service.js';
import { databaseErrorResponse } from '../utils/dbErrors.js';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';
import { sendLoginOtp } from '../services/sms.service.js';

const router = Router();

router.post(
  '/login',
  body('mobile').trim().isLength({ min: 10, max: 15 }).withMessage('Valid mobile required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      const mobile = String(req.body.mobile).trim();
      const otp = await issueLoginOtp(mobile);
      // Deliver via SMS. The console provider always returns ok:true;
      // live adapters (msg91/exotel/twilio) return {ok:false, error}
      // on delivery failure. If SMS actually fails, we surface a 503
      // so the client can show "couldn't send SMS" instead of a
      // misleading "OTP sent" that never arrives.
      let smsResult;
      try {
        smsResult = await sendLoginOtp(mobile, otp);
      } catch (e) {
        console.error('[auth/login] SMS send threw:', e);
        smsResult = { ok: false, error: e.message || 'sms_error' };
      }
      if (smsResult && smsResult.ok === false && smsResult.reason !== 'not_configured') {
        // Provider is configured but the send actually failed. Don't
        // pretend it worked. The DEV_STATIC_OTP escape hatch is
        // unaffected — those users can still log in with 1234.
        console.error('[auth/login] SMS dispatch reported failure', smsResult);
        return res.status(503).json({
          error: 'Could not deliver OTP right now — please try again in a moment',
        });
      }
      return res.json({ message: 'OTP sent' });
    } catch (err) {
      console.error('[auth/login] issueLoginOtp failed:', err);
      return res.status(500).json({ error: 'Could not send OTP — please try again' });
    }
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
