import { pool } from '../db/pool.js';

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
