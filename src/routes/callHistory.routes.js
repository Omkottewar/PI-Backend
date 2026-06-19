import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';

const router = Router();

// Create Call History
router.post(
  '/',
  body('userId').isInt().withMessage('userId must be an integer'),
  body('fromNumber').trim().notEmpty().withMessage('fromNumber is required'),
  body('toNumber').trim().notEmpty().withMessage('toNumber is required'),
  body('duration').isInt({ min: 0 }).withMessage('duration must be non-negative integer'),
  body('callDateTime').trim().notEmpty().withMessage('callDateTime is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId, fromNumber, toNumber, duration, callDateTime } = req.body;

    try {
      // Validate that user exists
      const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const r = await pool.query(
        `INSERT INTO "callHistory" ("userId", "fromNumber", "toNumber", duration, "callDateTime", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *`,
        [userId, fromNumber, toNumber, duration, callDateTime]
      );
      return res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error('Error creating call history:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// Fetch Call History By User
router.get('/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const r = await pool.query(
      `SELECT id, "userId", "fromNumber", "toNumber", duration, "callDateTime", "createdAt", "updatedAt"
       FROM "callHistory"
       WHERE "userId" = $1
       ORDER BY "callDateTime" DESC`,
      [userId]
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('Error fetching call history:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
