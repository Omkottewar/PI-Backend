import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validateFamilyRelation } from '../services/qr.service.js';
import { maskMobile } from '../utils/mask.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT id, name, mobile, email, age, address, created_at FROM users WHERE id = $1`,
    [req.userId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(r.rows[0]);
});

router.put(
  '/',
  requireAuth,
  body('name').optional({ nullable: true }).isString().trim(),
  body('email').optional({ nullable: true, values: 'falsy' }).isEmail().normalizeEmail(),
  body('age').optional({ nullable: true }).isInt({ min: 1, max: 150 }),
  body('address').optional({ nullable: true }).isString().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    // Only update fields the client explicitly sent. An empty string clears
    // the field; an absent key keeps the existing value. This is what the
    // user expects when they erase the address box and hit Save.
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
  }
);

router.get('/contacts', requireAuth, async (req, res) => {
  const r = await pool.query(`SELECT * FROM user_contacts WHERE user_id = $1 ORDER BY id`, [req.userId]);
  return res.json({ items: r.rows });
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
  const r = await pool.query(`DELETE FROM user_contacts WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Contact not found' });
  return res.json({ success: true });
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
          ca.caller_number,
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
      caller_number: reveal ? row.caller_number : maskMobile(row.caller_number),
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
});

export default router;
