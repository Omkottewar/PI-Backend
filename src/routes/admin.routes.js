import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { randomBytes, randomUUID } from 'crypto';
import JSZip from 'jszip';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { renderStickerPng } from '../utils/sticker.js';

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
         COUNT(*) FILTER (WHERE is_active = true AND used = false)::int AS awaiting,
         COUNT(*) FILTER (WHERE used = true)::int AS used,
         COUNT(*) FILTER (WHERE is_active = false AND used = false)::int AS deactivated
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
      // Referral codes may be reused across batches AND within a single
      // batch — the DB has no UNIQUE constraint on referral_code and the
      // activation flow keys by (unique_id, referral_code) where
      // unique_id (UUID) is per-sticker. So a whole shipment can share
      // one code as a "campaign token" if the admin wants.
      for (const c of customCodes) {
        if (!c || typeof c !== 'string') {
          return res.status(400).json({ error: 'customCodes must be non-empty strings' });
        }
      }
    }

    // Before doing anything, defensively resync the digits sequence to
    // MAX(digits) in the table. Migration 022 does this once, but a
    // subsequent DB restore or manual data load could put us out of
    // sync again — cheaper to fix on every mint than to fail one.
    // No-op when sequence is already ahead.
    //
    // `digits::text` is required because the column type has drifted
    // between VARCHAR and INTEGER across environments — without the
    // explicit cast the regex `~` errors out on INTEGER columns with
    // `operator does not exist: integer ~ unknown`, and the whole
    // resync gets silently swallowed by the catch. See migration 023
    // for the historical write-up.
    try {
      await pool.query(`
        SELECT setval('qrdata_digits_manual_seq',
                      GREATEST(
                        (SELECT COALESCE(MAX(CAST(digits::text AS INT)), 0)
                           FROM manual_qr WHERE digits::text ~ '^[0-9]+$'),
                        (SELECT COALESCE(MAX(CAST(digits::text AS INT)), 0)
                           FROM qrdata
                          WHERE is_manual = true AND digits::text ~ '^[0-9]+$'),
                        70000
                      ),
                      true)
      `);
    } catch (e) {
      console.warn('[admin/mint] pre-mint sequence resync skipped:', e.message);
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
      // Log the specific constraint so future issues aren't a mystery.
      console.error(
        '[admin/mint] error:',
        err.code, err.constraint || '(no constraint)', err.detail || '', err.message
      );
      if (err.code === '23505') {
        const c = err.constraint || '';
        if (c === 'manual_qr_digits_unique') {
          return res.status(409).json({
            error: 'Digits sequence out of sync with existing data. The next mint will auto-resync — please retry.',
          });
        }
        if (c === 'manual_qr_qr_unique_id_key' || c.includes('unique_id')) {
          return res.status(409).json({
            error: 'Rare UUID collision — retry the mint (a new UUID will be generated).',
          });
        }
        return res.status(409).json({
          error: `Uniqueness violation on ${c || 'unknown constraint'}. Please retry.`,
        });
      }
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ─── POST /api/admin/manual-qr/zip ──────────────────────────────────────
// Bundle a list of just-minted (or looked-up) manual QRs into a
// downloadable ZIP: one PNG per row (encoding alert_url), plus a
// manifest.csv. Client posts the items straight back after a successful
// /mint call — no server-side batch state, no DB re-lookup.
//
// Body: { items: [{ alert_url: string, digits: string|number,
//                   referral_code: string }, ...] }
//   Rejected if items missing / empty / >500 (matches mint cap).
router.post(
  '/manual-qr/zip',
  requireAdmin,
  body('items').isArray({ min: 1, max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const items = req.body.items;

    // Only alphanumerics, dash, underscore in filenames — everything
    // else (spaces, slashes, non-ASCII) gets collapsed to underscore so
    // Windows/macOS/Linux extraction is universally safe.
    const sanitize = (s) =>
      String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'code';

    try {
      const zip = new JSZip();
      const csvLines = ['digits,referral_code,unique_id,alert_url'];

      for (const it of items) {
        if (!it || typeof it.alert_url !== 'string' || !it.alert_url) {
          return res.status(400).json({ error: 'Each item needs alert_url' });
        }
        // Full sticker template (red header, medical crosses, extension
        // pill, black footer) matching the mobile app's QrDetailCard —
        // isManual=true skips the vehicle number line since these are
        // pre-print stickers.
        const png = await renderStickerPng({
          alertUrl: it.alert_url,
          digits: it.digits,
          isManual: true,
        });
        const filename = `${sanitize(it.digits)}_${sanitize(it.referral_code)}.png`;
        zip.file(filename, png);
        csvLines.push(
          [it.digits, it.referral_code, it.qr_unique_id || '', it.alert_url].join(',')
        );
      }

      // Manifest so the printer has both the visual QRs and the raw
      // metadata mapping.
      zip.file('manifest.csv', csvLines.join('\n'));

      const buf = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="manual-qrs-${Date.now()}.zip"`
      );
      res.setHeader('Content-Length', buf.length);
      return res.send(buf);
    } catch (err) {
      console.error('[admin/zip] error:', err);
      return res.status(500).json({ error: err.message });
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
    // Filter param: `?filter=awaiting | used | deactivated | all`
    //   awaiting    = is_active AND NOT used  (sticker in the wild, unredeemed)
    //   used        = used = true             (customer activated)
    //   deactivated = is_active = false AND NOT used  (admin recall / lost sticker)
    //   all / empty = no filter
    const filter = String(req.query.filter || req.query.active || '').trim();
    const search = String(req.query.search || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;

    const clauses = [];
    const params = [];
    if (filter === 'awaiting' || filter === 'true') {
      clauses.push(`mq.is_active = true AND mq.used = false`);
    } else if (filter === 'used') {
      clauses.push(`mq.used = true`);
    } else if (filter === 'deactivated' || filter === 'false') {
      clauses.push(`mq.is_active = false AND mq.used = false`);
    }
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
              mq.is_active, mq.used, mq.created_at,
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

// ─── GET /api/admin/payments/orphaned ───────────────────────────────────
// Payments stuck in 'created' status past a grace window (default 10m).
// Two causes:
//   a) User closed the Razorpay modal — no charge, safe to delete after
//      a longer grace (say 24h)
//   b) Razorpay charged but our /qr/create or /renew/verify failed before
//      markPaymentVerified — customer paid, no QR, refund required
// Admin ops should query this daily and cross-reference against the
// Razorpay dashboard to figure out which case each row is.
router.get('/payments/orphaned', requireAdmin, async (req, res) => {
  try {
    const olderThanMinutes = Math.max(
      1,
      parseInt(req.query.older_than_minutes, 10) || 10
    );
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { listOrphanedPayments } = await import('../services/payment.service.js');
    const items = await listOrphanedPayments({ olderThanMinutes, limit });
    return res.json({ items, older_than_minutes: olderThanMinutes, limit });
  } catch (err) {
    console.error('[admin/payments/orphaned] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/payments ────────────────────────────────────────────
// Recent Razorpay orders + verifications for reconciliation against the
// Razorpay dashboard. Joins in vehicle_number + user_mobile so admin
// can eyeball who paid for what without a second query.
//   Query params:
//     ?status=created|verified|failed   filter by status
//     ?limit=100 &offset=0
router.get('/payments', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const clauses = [];
    const params = [];
    if (['created', 'verified', 'failed'].includes(status)) {
      params.push(status);
      clauses.push(`p.status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM payments p ${where}`,
      params
    );
    const total = countRes.rows[0].total;

    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT p.id, p.user_id, p.qr_id, p.purpose,
              p.razorpay_order_id, p.razorpay_payment_id,
              p.amount_paise, p.intended_amount_paise, p.currency,
              p.status, p.error_message, p.created_at, p.verified_at,
              q.vehicle_number,
              u.mobile AS user_mobile
         FROM payments p
         LEFT JOIN qrdata q ON q.id = p.qr_id
         LEFT JOIN users u  ON u.id = p.user_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ items: rows.rows, total, limit, offset });
  } catch (err) {
    console.error('[admin/payments] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
