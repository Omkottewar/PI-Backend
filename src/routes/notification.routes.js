import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Send Notification (Authorized/Admins)
router.post(
  '/send',
  body('userIds').isArray().withMessage('userIds must be an array of strings/numbers'),
  body('title').trim().notEmpty().withMessage('title is required'),
  body('message').trim().notEmpty().withMessage('message is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userIds, title, message, sentBy, notificationType } = req.body;

    try {
      let targetUserIds = [];

      // Check for broadcast
      if (userIds.includes('all') || userIds.includes('*')) {
        const usersRes = await pool.query('SELECT id FROM users');
        targetUserIds = usersRes.rows.map(u => u.id);
      } else {
        targetUserIds = userIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
      }

      if (targetUserIds.length === 0) {
        return res.status(400).json({ error: 'No valid target users found' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const uId of targetUserIds) {
          await client.query(
            `INSERT INTO notifications ("userId", title, message, "isRead", "sentBy", "notificationType", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, false, $4, $5, NOW(), NOW())`,
            [uId, title, message, sentBy || 'admin', notificationType || 'general']
          );
        }
        await client.query('COMMIT');
        return res.status(201).json({ success: true, count: targetUserIds.length });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error sending notification:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// Get Notifications By User (with Pagination)
router.get('/user/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '20', 10);
  const offset = (page - 1) * limit;

  try {
    const countRes = await pool.query('SELECT COUNT(*)::int FROM notifications WHERE "userId" = $1', [userId]);
    const total = countRes.rows[0].count;

    const r = await pool.query(
      `SELECT id, "userId", title, message, "isRead", "sentBy", "notificationType", "createdAt", "updatedAt"
       FROM notifications
       WHERE "userId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.json({
      items: r.rows,
      page,
      limit,
      total
    });
  } catch (err) {
    console.error('Error fetching user notifications:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Mark Notification Read
router.put('/read/:notificationId', requireAuth, async (req, res) => {
  const { notificationId } = req.params;

  try {
    const r = await pool.query(
      `UPDATE notifications SET "isRead" = true, "updatedAt" = NOW()
       WHERE id = $1 RETURNING *`,
      [notificationId]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('Error marking notification read:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Delete Notification
router.delete('/:notificationId', requireAuth, async (req, res) => {
  const { notificationId } = req.params;

  try {
    const r = await pool.query('DELETE FROM notifications WHERE id = $1 RETURNING id', [notificationId]);
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    return res.json({ success: true, deletedId: notificationId });
  } catch (err) {
    console.error('Error deleting notification:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
