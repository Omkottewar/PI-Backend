import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

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

export default router;
