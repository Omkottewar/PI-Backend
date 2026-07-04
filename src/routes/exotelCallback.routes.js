import { Router } from 'express';
import { pool } from '../db/pool.js';
import { normalizeIndianMobile } from '../utils/phone.js';

const router = Router();

// How far back to look in alert_events for a location match. Bystander
// scans a QR → geolocates → dials → Exotel bridges → call ends → this
// webhook fires. The whole loop usually completes within 3-5 minutes;
// 10 gives us headroom for slow networks and IVR retries.
const LOCATION_LOOKBACK_MINUTES = 10;

// POST /api/exotel/call-completion
//   Called by Exotel's call-completion webhook after the bridged call
//   ends. Body carries CallSid, CallFrom, CallTo, DialCallDuration,
//   StartTime, EndTime.
//
//   Flow:
//     1. Normalize From/To to E.164.
//     2. Look up caller_activity keyed by (from_number, to_number) —
//        this tells us which QR the call was routed through and gives
//        us the qr_id needed to attribute the call to an owner.
//     3. Look up the most recent alert_events row for that qr_id in
//        the last LOCATION_LOOKBACK_MINUTES minutes that has a real
//        lat/lng (bystanders can deny the browser prompt).
//     4. INSERT into call_logs with the merged data.
router.post('/call-completion', async (req, res) => {
  const {
    CallSid,
    CallFrom,
    CallTo,
    DialCallDuration,
    StartTime,
    EndTime,
  } = req.body || {};

  console.log('[exotel/call-completion]', {
    CallSid,
    CallFrom,
    CallTo,
    DialCallDuration,
    StartTime,
    EndTime,
  });

  const fromNumber = normalizeIndianMobile(CallFrom);
  const toNumber = normalizeIndianMobile(CallTo);
  const callSid = String(CallSid || '').trim() || null;
  const durationSec =
    DialCallDuration != null && DialCallDuration !== ''
      ? Number(DialCallDuration)
      : null;
  const startTime = parseTs(StartTime);
  const endTime = parseTs(EndTime);

  try {
    // Look up qr_id via caller_activity. If a caller called two different
    // family members on the same QR quickly, to_number on caller_activity
    // may not exactly match the earlier call's CallTo — so we order by
    // last_call_at desc and take the freshest row.
    let qrId = null;
    if (fromNumber && toNumber) {
      const act = await pool.query(
        `SELECT qr_id
           FROM caller_activity
          WHERE from_number = $1
            AND to_number   = $2
          ORDER BY last_call_at DESC
          LIMIT 1`,
        [fromNumber, toNumber]
      );
      if (act.rows.length) qrId = act.rows[0].qr_id;
    }

    // Pull location from the most recent alert_events row for this QR
    // within the lookback window. Only accept rows that actually carry
    // a lat/lng — bystanders who denied the prompt still have a row.
    let lat = null;
    let lng = null;
    let accuracy = null;
    if (qrId) {
      const ev = await pool.query(
        `SELECT latitude, longitude, accuracy_meters
           FROM alert_events
          WHERE qr_id = $1
            AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
            AND latitude IS NOT NULL
            AND longitude IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [qrId, String(LOCATION_LOOKBACK_MINUTES)]
      );
      if (ev.rows.length) {
        lat = ev.rows[0].latitude;
        lng = ev.rows[0].longitude;
        accuracy = ev.rows[0].accuracy_meters;
      }
    }

    await pool.query(
      `INSERT INTO call_logs
         (qr_id, to_number, from_number, call_sid,
          duration, start_time, end_time,
          latitude, longitude, accuracy_meters,
          status,
          caller_number, receiver_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        qrId,
        toNumber || null,
        fromNumber || null,
        callSid,
        durationSec,
        startTime,
        endTime,
        lat,
        lng,
        accuracy,
        'completed',
        // Legacy columns — keep populating so existing dashboards still work.
        fromNumber || null,
        toNumber || null,
      ]
    );

    if (!qrId) {
      console.warn(
        '[exotel/call-completion] no caller_activity match for ' +
          `from=${fromNumber} to=${toNumber} sid=${callSid} — call log ` +
          'inserted with qr_id NULL (unattributed).'
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[exotel/call-completion] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

function parseTs(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default router;
