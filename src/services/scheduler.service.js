import { pool } from '../db/pool.js';
import { sendExpiryCountdown } from './sms.service.js';

export function startExpiryScheduler() {
  const run = async () => {
    console.log('[Scheduler] Running auto-expiry validation job...');
    try {
      const res = await pool.query(`
        UPDATE qrdata
        SET is_active = false
        WHERE date_of_activation + INTERVAL '1 year' < NOW() AND is_active = true
        RETURNING id, vehicle_number
      `);
      if (res.rowCount > 0) {
        console.log(`[Scheduler] Auto-expired ${res.rowCount} vehicle records successfully.`);
        res.rows.forEach(row => {
          console.log(`[Scheduler] Expired vehicle: ${row.vehicle_number} (ID: ${row.id})`);
        });
      } else {
        console.log('[Scheduler] No expired vehicle records found.');
      }
    } catch (err) {
      console.error('[Scheduler] Error running auto-expiry job:', err);
    }
  };

  // Execute on startup
  run();

  // Schedule to run every 12 hours (12 hours * 60 minutes * 60 seconds * 1000 milliseconds)
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  setInterval(run, TWELVE_HOURS);
}

// ─── Daily expiry-countdown SMS ─────────────────────────────────────────
// For every active QR whose activation date lands in the (365-7)..365 day
// window, send one SMS per day counting down. We fire once per JS boot
// AND on a 24h interval — combined with an idempotency guard the caller
// only sees one message per day even across pod restarts.
//
// Idempotency: we UPSERT a row into `sms_expiry_log` keyed by
// (qr_id, days_left) so a same-day rerun (e.g., after a redeploy) is a
// no-op. The table is created lazily on first run so we don't need
// a full migration for this one small helper.
export function startExpiryCountdownScheduler() {
  const ensureLogTable = async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_expiry_log (
        qr_id       INT NOT NULL,
        days_left   INT NOT NULL,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (qr_id, days_left)
      )
    `);
  };

  const run = async () => {
    console.log('[Scheduler] Running expiry countdown SMS job...');
    try {
      await ensureLogTable();
      // Pull every active QR whose remaining lifetime is between 1 and 7
      // days inclusive. Joined with users so we always have a fallback
      // mobile even if the QR row lacks one.
      const r = await pool.query(`
        SELECT q.id, q.mobile, q.vehicle_number, u.mobile AS user_mobile,
               (q.date_of_activation + INTERVAL '1 year') AS expiry_at,
               GREATEST(
                 1,
                 EXTRACT(DAY FROM (
                   q.date_of_activation + INTERVAL '1 year' - NOW()
                 ))::int
               ) AS days_left
          FROM qrdata q
          LEFT JOIN users u ON u.id = q.user_id
         WHERE q.is_active = true
           AND q.date_of_activation IS NOT NULL
           AND (q.date_of_activation + INTERVAL '1 year') > NOW()
           AND (q.date_of_activation + INTERVAL '1 year') <= NOW() + INTERVAL '7 days'
      `);
      if (!r.rows.length) {
        console.log('[Scheduler] No QRs in expiry window today.');
        return;
      }
      let sentCount = 0;
      for (const row of r.rows) {
        const to = row.mobile || row.user_mobile;
        if (!to) continue;
        // Idempotency guard — INSERT ... ON CONFLICT DO NOTHING gives us
        // an "already sent today for this qr+days combo" check with no
        // extra round trip.
        const claim = await pool.query(
          `INSERT INTO sms_expiry_log (qr_id, days_left)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING qr_id`,
          [row.id, row.days_left]
        );
        if (!claim.rows.length) continue; // already sent
        const smsResult = await sendExpiryCountdown({
          mobile: to,
          days_left: row.days_left,
          expiry_date: row.expiry_at,
        });
        if (smsResult && smsResult.ok) {
          sentCount += 1;
        } else {
          // The DLT template can be `disabled: true` while we work out
          // an operator issue, or the provider itself may return a
          // transient failure. Either way, release the idempotency
          // slot so tomorrow's run tries again instead of thinking it
          // already delivered.
          await pool
            .query(
              `DELETE FROM sms_expiry_log WHERE qr_id = $1 AND days_left = $2`,
              [row.id, row.days_left]
            )
            .catch((e) =>
              console.error('[Scheduler] failed to release log row:', e.message)
            );
        }
      }
      console.log(`[Scheduler] Expiry countdown SMS sent: ${sentCount}`);
    } catch (err) {
      console.error('[Scheduler] Error running expiry countdown job:', err);
    }
  };

  run();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setInterval(run, TWENTY_FOUR_HOURS);
}

// ─── Stale in-progress call_logs cleanup ────────────────────────────────
// /exotel/lookup inserts a pending call_logs row (status='in-progress')
// that the completion webhook is supposed to UPDATE. If Exotel's
// callback never arrives (network failure, service outage, etc.), the
// row sits in-progress forever — which shows up as a "call in progress"
// tile in the owner's app indefinitely. Marks anything older than 30
// minutes as 'timeout' so the History tab reflects reality.
export function startCallLogsCleanupScheduler() {
  const run = async () => {
    console.log('[Scheduler] Running stale call_logs cleanup...');
    try {
      const r = await pool.query(`
        UPDATE call_logs
           SET status = 'timeout',
               end_time = COALESCE(end_time, NOW())
         WHERE status = 'in-progress'
           AND start_time IS NOT NULL
           AND start_time < NOW() - INTERVAL '30 minutes'
      `);
      if (r.rowCount > 0) {
        console.log(`[Scheduler] Marked ${r.rowCount} stale call_logs as timeout.`);
      }
    } catch (err) {
      console.error('[Scheduler] call_logs cleanup failed:', err);
    }
  };
  run();
  const THIRTY_MINUTES = 30 * 60 * 1000;
  setInterval(run, THIRTY_MINUTES);
}
