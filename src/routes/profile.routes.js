import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validateFamilyRelation } from '../services/qr.service.js';
import { maskMobile } from '../utils/mask.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, mobile, email, age, address, created_at FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[profile GET] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.put(
  '/',
  requireAuth,
  body('name').optional({ nullable: true }).isString().trim(),
  // gmail_remove_dots: false so "om.kottewar@gmail.com" isn't silently
  // rewritten to "omkottewar@gmail.com" — Gmail treats them as the same
  // inbox, but the user typed the version they want on record.
  body('email').optional({ nullable: true, values: 'falsy' })
    .isEmail()
    .normalizeEmail({ gmail_remove_dots: false }),
  body('age').optional({ nullable: true }).isInt({ min: 1, max: 150 }),
  body('address').optional({ nullable: true }).isString().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      // Only update fields the client explicitly sent. An empty string clears
      // the field; an absent key keeps the existing value.
      const sets = [];
      const params = [req.userId];
      const push = (col, value) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };

      if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
        const v = req.body.name;
        push('name', v == null ? null : String(v).trim() || null);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
        const v = req.body.email;
        push('email', v == null || v === '' ? null : String(v).trim());
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'age')) {
        const v = req.body.age;
        push('age', v == null || v === '' ? null : Number(v));
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'address')) {
        const v = req.body.address;
        push('address', v == null ? null : String(v).trim() || null);
      }

      if (sets.length === 0) {
        const cur = await pool.query(
          `SELECT id, name, mobile, email, age, address, created_at FROM users WHERE id = $1`,
          [req.userId]
        );
        if (!cur.rows.length) return res.status(404).json({ error: 'User not found' });
        return res.json(cur.rows[0]);
      }

      const r = await pool.query(
        `UPDATE users SET ${sets.join(', ')}
         WHERE id = $1
         RETURNING id, name, mobile, email, age, address, created_at`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      return res.json(r.rows[0]);
    } catch (err) {
      console.error('[profile PUT] error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

router.get('/contacts', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM user_contacts WHERE user_id = $1 ORDER BY id`, [req.userId]);
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('[profile/contacts GET] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post(
  '/contacts',
  requireAuth,
  body('name').trim().notEmpty(),
  body('phone').trim().isLength({ min: 10 }),
  body('relation').custom(v => validateFamilyRelation(v)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    // Check max 5
    const countRes = await pool.query(`SELECT COUNT(*) FROM user_contacts WHERE user_id = $1`, [req.userId]);
    if (parseInt(countRes.rows[0].count, 10) >= 5) {
      return res.status(400).json({ error: 'Maximum 5 contacts allowed' });
    }
    
    // Check duplicate phone
    const phone = req.body.phone.trim();
    const dupRes = await pool.query(`SELECT id FROM user_contacts WHERE user_id = $1 AND phone = $2`, [req.userId, phone]);
    if (dupRes.rows.length > 0) return res.status(400).json({ error: 'Contact phone already exists' });

    const { name, relation } = req.body;
    const r = await pool.query(
      `INSERT INTO user_contacts (user_id, name, phone, relation) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.userId, name, phone, relation]
    );
    return res.status(201).json(r.rows[0]);
  }
);

router.put(
  '/contacts/:id',
  requireAuth,
  body('name').optional().trim().notEmpty(),
  body('phone').optional().trim().isLength({ min: 10 }),
  body('relation').optional().custom(v => validateFamilyRelation(v)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const existing = await pool.query(`SELECT * FROM user_contacts WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Contact not found' });

    const { name, phone, relation } = req.body;

    if (phone) {
       const dupRes = await pool.query(`SELECT id FROM user_contacts WHERE user_id = $1 AND phone = $2 AND id != $3`, [req.userId, phone, req.params.id]);
       if (dupRes.rows.length > 0) return res.status(400).json({ error: 'Contact phone already exists' });
    }

    const r = await pool.query(
      `UPDATE user_contacts SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         relation = COALESCE($3, relation)
       WHERE id = $4 AND user_id = $5 RETURNING *`,
      [name || null, phone || null, relation || null, req.params.id, req.userId]
    );
    return res.json(r.rows[0]);
  }
);

router.delete('/contacts/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM user_contacts WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Contact not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[profile/contacts DELETE] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET list of all users (for notification admin lookup)
router.get('/users', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, mobile, email FROM users ORDER BY name ASC');
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('Error fetching users:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST update current user's device token
router.post('/device-token', requireAuth,
  body('deviceToken').trim().notEmpty().withMessage('deviceToken is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceToken } = req.body;
    try {
      await pool.query(
        'UPDATE users SET "deviceToken" = $1 WHERE id = $2',
        [deviceToken, req.userId]
      );
      return res.json({ success: true, message: 'Device token saved' });
    } catch (err) {
      console.error('Error saving device token:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─── Caller activity ────────────────────────────────────────────────────
// Every Exotel lookup writes to caller_activity so the owner can see who has
// been calling their QR. The listing endpoint masks phone numbers by default;
// pass ?reveal=true to see full numbers (useful for the "Reveal" UI button).
// Block / unblock endpoints toggle is_blocked which the Exotel lookup honours.

router.get('/caller-activity', requireAuth, async (req, res) => {
  const reveal = String(req.query.reveal || '').toLowerCase() === 'true';
  try {
    const r = await pool.query(
      `SELECT
          ca.id,
          ca.qr_id,
          q.vehicle_number,
          q.digits,
          ca.from_number,
          ca.to_number,
          ca.last_call_sid,
          ca.call_count,
          ca.first_call_at,
          ca.last_call_at,
          ca.is_blocked,
          ca.blocked_at
        FROM caller_activity ca
        JOIN qrdata q ON q.id = ca.qr_id
        WHERE q.user_id = $1
        ORDER BY ca.call_count DESC, ca.last_call_at DESC
        LIMIT 200`,
      [req.userId]
    );
    const items = r.rows.map((row) => ({
      ...row,
      from_number: reveal ? row.from_number : maskMobile(row.from_number),
      to_number: reveal ? row.to_number : maskMobile(row.to_number),
    }));
    return res.json({ items });
  } catch (err) {
    console.error('Error fetching caller activity:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Verifies the activity row belongs to a QR owned by the requesting user.
// Returns the row id if OK, or null (so caller can 404 the request).
async function assertActivityOwnedBy(activityId, userId) {
  const check = await pool.query(
    `SELECT ca.id
       FROM caller_activity ca
       JOIN qrdata q ON q.id = ca.qr_id
      WHERE ca.id = $1 AND q.user_id = $2`,
    [activityId, userId]
  );
  return check.rows.length ? check.rows[0].id : null;
}

router.post('/caller-activity/:id/block', requireAuth, async (req, res) => {
  const activityId = parseInt(req.params.id, 10);
  if (!Number.isFinite(activityId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const ok = await assertActivityOwnedBy(activityId, req.userId);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  await pool.query(
    `UPDATE caller_activity
        SET is_blocked = true, blocked_at = NOW()
      WHERE id = $1`,
    [activityId]
  );
  return res.json({ ok: true });
});

router.delete('/caller-activity/:id/block', requireAuth, async (req, res) => {
  const activityId = parseInt(req.params.id, 10);
  if (!Number.isFinite(activityId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const ok = await assertActivityOwnedBy(activityId, req.userId);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  await pool.query(
    `UPDATE caller_activity
        SET is_blocked = false, blocked_at = NULL
      WHERE id = $1`,
    [activityId]
  );
  return res.json({ ok: true });
});

// ─── Alerts ─────────────────────────────────────────────────────────────
// One row per bystander tap on the alert page. Returns the last 90 days of
// events across all of the caller's QRs, most recent first, with lat/lng
// so the mobile client can build a "View on Google Maps" link.

router.get('/alerts', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
          ae.id,
          ae.qr_id,
          q.vehicle_number,
          ae.contact_kind,
          ae.contact_family_id,
          fd.relation AS contact_family_relation,
          fd.name     AS contact_family_name,
          ae.latitude,
          ae.longitude,
          ae.accuracy_meters,
          ae.user_agent,
          ae.seen_at,
          ae.created_at
        FROM alert_events ae
        JOIN qrdata q ON q.id = ae.qr_id
        LEFT JOIN family_details fd ON fd.id = ae.contact_family_id
       WHERE q.user_id = $1
         AND ae.created_at > NOW() - INTERVAL '90 days'
       ORDER BY ae.created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('Error fetching alerts:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/alerts/:id/dismiss', requireAuth, async (req, res) => {
  const alertId = parseInt(req.params.id, 10);
  if (!Number.isFinite(alertId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const check = await pool.query(
      `SELECT ae.id
         FROM alert_events ae
         JOIN qrdata q ON q.id = ae.qr_id
        WHERE ae.id = $1 AND q.user_id = $2`,
      [alertId, req.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    await pool.query(
      `UPDATE alert_events SET seen_at = NOW() WHERE id = $1`,
      [alertId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[profile/alerts/dismiss] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Call logs (owner-facing) ────────────────────────────────────────────
// Backed by call_logs rows written by the /api/exotel/call-completion
// webhook. Only rows that could be attributed to a QR (qr_id NOT NULL)
// are surfaced here — orphaned rows (legacy /alert/create-call inserts,
// or Exotel completions that didn't match any caller_activity) stay
// hidden from the owner UI.
//
// Numbers are masked by default; pass ?reveal=true for full values.

router.get('/call-logs', requireAuth, async (req, res) => {
  const reveal = String(req.query.reveal || '').toLowerCase() === 'true';
  console.log('[profile/call-logs] list', { userId: req.userId, reveal });
  try {
    const r = await pool.query(
      `SELECT
          cl.id,
          cl.qr_id,
          q.vehicle_number,
          cl.call_sid,
          cl.to_number,
          cl.from_number,
          cl.duration,
          cl.start_time,
          cl.end_time,
          cl.latitude,
          cl.longitude,
          cl.accuracy_meters,
          COALESCE(ca.is_blocked, false) AS is_blocked
        FROM call_logs cl
        JOIN qrdata q ON q.id = cl.qr_id
        LEFT JOIN caller_activity ca
          ON ca.qr_id = cl.qr_id AND ca.from_number = cl.from_number
       WHERE q.user_id = $1
         AND cl.qr_id IS NOT NULL
       ORDER BY cl.start_time DESC NULLS LAST, cl.id DESC
       LIMIT 100`,
      [req.userId]
    );
    console.log('[profile/call-logs] found', {
      userId: req.userId,
      count: r.rows.length,
      firstId: r.rows[0]?.id,
    });
    const items = r.rows.map((row) => ({
      ...row,
      from_number: reveal ? row.from_number : maskMobile(row.from_number),
      to_number: reveal ? row.to_number : maskMobile(row.to_number),
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[profile/call-logs] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Block the caller whose (qr_id, from_number) matches this call log row.
// Looks up the caller_activity row that /exotel/lookup created for that
// pair and flips is_blocked. If no matching row exists (edge case — the
// call log's from_number was never seen by /exotel/lookup), we create
// one with call_count=0 so the block still takes effect on the next call.
router.post('/call-logs/:id/block', requireAuth, async (req, res) => {
  const logId = parseInt(req.params.id, 10);
  console.log('[profile/call-logs/block]', { userId: req.userId, logId });
  if (!Number.isFinite(logId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const check = await pool.query(
      `SELECT cl.qr_id, cl.from_number, cl.to_number
         FROM call_logs cl
         JOIN qrdata q ON q.id = cl.qr_id
        WHERE cl.id = $1 AND q.user_id = $2`,
      [logId, req.userId]
    );
    if (!check.rows.length) {
      console.warn('[profile/call-logs/block] log not found or not owned', { logId, userId: req.userId });
      return res.status(404).json({ error: 'Not found' });
    }
    const { qr_id, from_number, to_number } = check.rows[0];
    console.log('[profile/call-logs/block] resolved', { qr_id, from_number, to_number });
    if (!qr_id || !from_number) {
      return res.status(400).json({
        error: 'Call log has no qr_id or from_number to attribute the block to',
      });
    }

    const upserted = await pool.query(
      `INSERT INTO caller_activity
         (qr_id, from_number, to_number, call_count,
          first_call_at, last_call_at, is_blocked, blocked_at)
       VALUES ($1, $2, $3, 0, NOW(), NOW(), true, NOW())
       ON CONFLICT (qr_id, from_number) DO UPDATE
         SET is_blocked = true,
             blocked_at = NOW()
       RETURNING id, call_count, is_blocked`,
      [qr_id, from_number, to_number || null]
    );
    console.log('[profile/call-logs/block] caller_activity upserted', upserted.rows[0]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[profile/call-logs/block] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
