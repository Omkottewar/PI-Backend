import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validateFamilyRelation } from '../services/qr.service.js';

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
  body('name').optional().isString().trim(),
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('age').optional().isInt({ min: 1, max: 150 }),
  body('address').optional().isString().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { name, email, age, address } = req.body;
    const r = await pool.query(
      `UPDATE users SET
        name = COALESCE(NULLIF(TRIM($2::text), ''), name),
        email = COALESCE(NULLIF(TRIM($3::text), ''), email),
        age = COALESCE($4, age),
        address = COALESCE(NULLIF(TRIM($5::text), ''), address)
      WHERE id = $1
      RETURNING id, name, mobile, email, age, address, created_at`,
      [
        req.userId,
        name === undefined ? null : String(name),
        email === undefined ? null : String(email),
        age === undefined ? null : age,
        address === undefined ? null : String(address),
      ]
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

export default router;
