import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { randomBytes, randomUUID } from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { requireAdmin } from '../middleware/adminAuth.js';

const router = Router();

// Auto-generate an 8-character A-Z0-9 referral code. Distinct from anything
// users type by hand, easy to read off a printed sticker.
function generateReferralCode() {
  return randomBytes(4).toString('hex').toUpperCase();
}

// ─── GET /api/admin/stats ───────────────────────────────────────────────
// Overview counters for the admin dashboard.
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_active = true)::int AS unactivated,
         COUNT(*) FILTER (WHERE is_active = false)::int AS activated
       FROM manual_qr`
    );
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[admin/stats] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/manual-qr/mint ─────────────────────────────────────
// Mint a batch of new manual_qr rows. Each gets a fresh UUID, a digits
// value allocated from qrdata_digits_manual_seq, and either an auto-
// generated referral code or one from the caller-supplied array.
//
// Body: { count: 1..500, prefix?: "BATCH-", customCodes?: string[] }
//   customCodes.length MUST equal count when provided; overrides autogen.
router.post(
  '/manual-qr/mint',
  requireAdmin,
  body('count').isInt({ min: 1, max: 500 }),
  body('prefix').optional({ nullable: true }).isString().trim().isLength({ max: 20 }),
  body('customCodes').optional({ nullable: true }).isArray(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const count = req.body.count;
    const prefix = (req.body.prefix || '').trim();
    const customCodes = req.body.customCodes;

    if (customCodes && customCodes.length !== count) {
      return res.status(400).json({
        error: `customCodes length (${customCodes.length}) must equal count (${count})`,
      });
    }
    if (customCodes) {
      const seen = new Set();
      for (const c of customCodes) {
        if (!c || typeof c !== 'string') {
          return res.status(400).json({ error: 'customCodes must be non-empty strings' });
        }
        if (seen.has(c)) {
          return res.status(400).json({ error: `Duplicate referral code in batch: ${c}` });
        }
        seen.add(c);
      }
    }

    const created = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < count; i++) {
        const uniqueId = randomUUID();
        const referralCode = customCodes
          ? String(customCodes[i]).trim()
          : `${prefix}${generateReferralCode()}`;
        const seqRes = await client.query(
          `SELECT nextval('qrdata_digits_manual_seq')::text AS digits`
        );
        const digits = seqRes.rows[0].digits;
        const insertRes = await client.query(
          `INSERT INTO manual_qr (qr_unique_id, referral_code, digits, is_active)
           VALUES ($1, $2, $3, true)
           RETURNING id, qr_unique_id, referral_code, digits, is_active, created_at`,
          [uniqueId, referralCode, digits]
        );
        created.push(insertRes.rows[0]);
      }
      await client.query('COMMIT');

      const publicUrl = String(config.publicAppUrl || '').replace(/\/$/, '');
      const withUrls = created.map((row) => ({
        ...row,
        alert_url: `${publicUrl}/alert/${row.qr_unique_id}?digits=${row.digits}`,
      }));

      console.log(`[admin/mint] created ${count} manual_qr rows (prefix="${prefix}")`);
      return res.json({ ok: true, count, items: withUrls });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[admin/mint] error:', err);
      if (err.code === '23505') {
        return res
          .status(409)
          .json({ error: 'A referral code in the batch is already taken. Try again.' });
      }
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ─── GET /api/admin/manual-qr ───────────────────────────────────────────
// Paginated list of all manual_qr rows. LEFT JOIN qrdata + users so we
// can show who activated each one (if any).
//   Query params:
//     ?active=true|false   filter by is_active
//     ?search=CODE|10071   substring match on referral_code OR digits
//     ?limit=50 &offset=0
router.get('/manual-qr', requireAdmin, async (req, res) => {
  try {
    const active = String(req.query.active || '');
    const search = String(req.query.search || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;

    const clauses = [];
    const params = [];
    if (active === 'true') clauses.push(`mq.is_active = true`);
    else if (active === 'false') clauses.push(`mq.is_active = false`);
    if (search) {
      params.push(`%${search}%`);
      clauses.push(
        `(mq.referral_code ILIKE $${params.length} OR mq.digits ILIKE $${params.length})`
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM manual_qr mq ${where}`,
      params
    );
    const total = countRes.rows[0].total;

    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT mq.id, mq.qr_unique_id, mq.referral_code, mq.digits,
              mq.is_active, mq.created_at,
              q.vehicle_number, q.name AS owner_name,
              u.mobile AS activated_by_mobile
         FROM manual_qr mq
         LEFT JOIN qrdata q ON q.unique_id = mq.qr_unique_id
         LEFT JOIN users u ON u.id = q.user_id
         ${where}
         ORDER BY mq.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const publicUrl = String(config.publicAppUrl || '').replace(/\/$/, '');
    const items = rows.rows.map((row) => ({
      ...row,
      alert_url: `${publicUrl}/alert/${row.qr_unique_id}?digits=${row.digits}`,
    }));

    return res.json({ items, total, limit, offset });
  } catch (err) {
    console.error('[admin/list] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/manual-qr/:id/deactivate ───────────────────────────
// Soft-invalidate a specific manual_qr. Used when a sticker is lost /
// unshipped so the referral code can never be redeemed.
router.post('/manual-qr/:id/deactivate', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(
      `UPDATE manual_qr SET is_active = false WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    console.log(`[admin/deactivate] id=${id}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/deactivate] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/manual-qr/export.csv ────────────────────────────────
// CSV dump for handoff to the sticker printer.
router.get('/manual-qr/export.csv', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT qr_unique_id, referral_code, digits, is_active, created_at
         FROM manual_qr
        ORDER BY created_at DESC`
    );
    const publicUrl = String(config.publicAppUrl || '').replace(/\/$/, '');
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = ['unique_id,referral_code,digits,is_active,created_at,alert_url'];
    for (const row of r.rows) {
      const alertUrl = `${publicUrl}/alert/${row.qr_unique_id}?digits=${row.digits}`;
      lines.push(
        [
          esc(row.qr_unique_id),
          esc(row.referral_code),
          esc(row.digits),
          esc(row.is_active),
          esc(row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at),
          esc(alertUrl),
        ].join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manual-qrs-${Date.now()}.csv"`);
    return res.send(lines.join('\n'));
  } catch (err) {
    console.error('[admin/export] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
