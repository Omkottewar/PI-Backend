import { Router } from 'express';
import { pool } from '../db/pool.js';
import { normalizeIndianMobile } from '../utils/phone.js';

const router = Router();

// How far back to look in alert_events for a location match. Bystander
// scans a QR → geolocates → dials → Exotel bridges → call ends → this
// webhook fires. The whole loop usually completes within 3-5 minutes;
// 10 gives us headroom for slow networks and IVR retries.
const LOCATION_LOOKBACK_MINUTES = 10;

// GET /api/exotel/call-completion?CallSid=...&CallFrom=...&CallTo=...&DialCallDuration=...&StartTime=...&EndTime=...
//   Called by Exotel's call-completion webhook after the bridged call
//   ends. All parameters arrive on the query string (Exotel appends
//   them to the URL when firing the webhook). We also fall back to
//   HTTP headers for anything not present in the query, so this route
//   is resilient to Exotel account configs that pass values either way.
//
//   Flow:
//     1. Read every possible field from query + headers + body.
//     2. Normalize From/To to E.164.
//     3. Look up caller_activity keyed by (from_number, to_number) —
//        this tells us which QR the call was routed through and gives
//        us the qr_id needed to attribute the call to an owner.
//     4. Look up the most recent alert_events row for that qr_id in
//        the last LOCATION_LOOKBACK_MINUTES minutes that has a real
//        lat/lng (bystanders can deny the browser prompt).
//     5. INSERT into call_logs with the merged data.
router.get('/call-completion', async (req, res) => {
  // Read a field from query, then headers, then body — first non-empty
  // wins. Case-insensitive: Exotel sends "CallSid" but some proxies
  // downcase headers to "callsid".
  const pick = (name) => {
    const variants = [
      name,
      name.toLowerCase(),
      name.toUpperCase(),
      // camelCase → header-case (CallSid → call-sid, callsid)
      name.replace(/([A-Z])/g, '-$1').replace(/^-/, '').toLowerCase(),
    ];
    for (const key of variants) {
      const q = req.query?.[key];
      if (q != null && q !== '') return q;
      const h = req.headers?.[key];
      if (h != null && h !== '') return h;
      const b = req.body?.[key];
      if (b != null && b !== '') return b;
    }
    return undefined;
  };

  const CallSid = pick('CallSid');
  const CallFrom = pick('CallFrom');
  const CallTo = pick('CallTo');
  const DialCallDuration = pick('DialCallDuration');
  const StartTime = pick('StartTime');
  const EndTime = pick('EndTime');
  const DialCallStatus = pick('DialCallStatus');
  const Direction = pick('Direction');

  // Dump every source we looked at so debugging shows exactly what
  // Exotel is actually sending and where.
  console.log('[exotel/call-completion] full request dump', {
    resolved: {
      CallSid,
      CallFrom,
      CallTo,
      DialCallDuration,
      StartTime,
      EndTime,
      DialCallStatus,
      Direction,
    },
    query: req.query,
    headers: req.headers,
    body: req.body && Object.keys(req.body).length ? req.body : undefined,
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

  console.log('[callback] normalized', {
    fromNumber,
    toNumber,
    callSid,
    durationSec,
    startTime,
    endTime,
  });

  try {
    // Step 1 — resolve qr_id via caller_activity
    let qrId = null;
    if (fromNumber && toNumber) {
      const act = await pool.query(
        `SELECT qr_id, id, call_count, is_blocked
           FROM caller_activity
          WHERE from_number = $1
            AND to_number   = $2
          ORDER BY last_call_at DESC
          LIMIT 1`,
        [fromNumber, toNumber]
      );
      console.log('[callback] caller_activity lookup', {
        matched: act.rows.length,
        row: act.rows[0] || null,
      });
      if (act.rows.length) qrId = act.rows[0].qr_id;
    } else {
      console.warn('[callback] skipping caller_activity lookup — missing fromNumber or toNumber');
    }

    // Step 2 — pull the most recent geolocation for this QR in the lookback window
    let lat = null;
    let lng = null;
    let accuracy = null;
    if (qrId) {
      const ev = await pool.query(
        `SELECT id, latitude, longitude, accuracy_meters, created_at
           FROM alert_events
          WHERE qr_id = $1
            AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
            AND latitude IS NOT NULL
            AND longitude IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [qrId, String(LOCATION_LOOKBACK_MINUTES)]
      );
      console.log('[callback] alert_events lookup', {
        qr_id: qrId,
        lookback_minutes: LOCATION_LOOKBACK_MINUTES,
        matched: ev.rows.length,
        row: ev.rows[0] || null,
      });
      if (ev.rows.length) {
        lat = ev.rows[0].latitude;
        lng = ev.rows[0].longitude;
        accuracy = ev.rows[0].accuracy_meters;
      }
    }

    // Step 3 — insert into call_logs
    const inserted = await pool.query(
      `INSERT INTO call_logs
         (qr_id, to_number, from_number, call_sid,
          duration, start_time, end_time,
          latitude, longitude, accuracy_meters,
          status,
          caller_number, receiver_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
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
        DialCallStatus ? String(DialCallStatus) : 'completed',
        fromNumber || null,
        toNumber || null,
      ]
    );

    console.log('[callback] call_logs inserted', {
      id: inserted.rows[0].id,
      qr_id: qrId,
      has_location: lat != null && lng != null,
      unattributed: !qrId,
    });

    if (!qrId) {
      console.warn(
        '[callback] UNATTRIBUTED — no caller_activity match for ' +
          `from=${fromNumber} to=${toNumber} sid=${callSid}. ` +
          'call_logs row created with qr_id NULL.'
      );
    }

    return res.json({ ok: true, call_log_id: inserted.rows[0].id });
  } catch (err) {
    console.error('[callback] error:', err);
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
