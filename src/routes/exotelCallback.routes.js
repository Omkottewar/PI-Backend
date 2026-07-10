import { Router } from 'express';
import { pool } from '../db/pool.js';
import { normalizeIndianMobile } from '../utils/phone.js';
import { notifyUser } from '../services/push.service.js';
import { maskMobile } from '../utils/mask.js';

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
    // Step 1a — prefer the pending call_logs row inserted by /exotel/lookup
    // during this exact call. This is race-free because call_sid is unique.
    let qrId = null;
    let pendingId = null;
    if (callSid) {
      const pending = await pool.query(
        `SELECT id, qr_id FROM call_logs WHERE call_sid = $1 LIMIT 1`,
        [callSid]
      );
      console.log('[callback] pending call_logs lookup by call_sid', {
        matched: pending.rows.length,
        row: pending.rows[0] || null,
      });
      if (pending.rows.length) {
        pendingId = pending.rows[0].id;
        qrId = pending.rows[0].qr_id;
      }
    }

    // Step 1b — legacy fallback: attribute via caller_activity (from, to).
    // Only used if there's no pending row (lookup didn't fire, or CallSid
    // mismatch between the two Exotel applets).
    if (!qrId && fromNumber && toNumber) {
      const act = await pool.query(
        `SELECT qr_id, id, call_count, is_blocked
           FROM caller_activity
          WHERE from_number = $1
            AND to_number   = $2
          ORDER BY last_call_at DESC
          LIMIT 1`,
        [fromNumber, toNumber]
      );
      console.log('[callback] fallback caller_activity lookup', {
        matched: act.rows.length,
        row: act.rows[0] || null,
      });
      if (act.rows.length) qrId = act.rows[0].qr_id;
    }
    if (!qrId && !pendingId) {
      console.warn('[callback] no attribution match — call_logs will be inserted with qr_id NULL');
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

    // Step 3 — write the call log.
    // If we have a pending row from lookup, UPDATE it in place (race-free).
    // If not (edge case), INSERT a fresh row.
    const statusStr = DialCallStatus ? String(DialCallStatus) : 'completed';
    let callLogId;

    if (pendingId) {
      const updated = await pool.query(
        `UPDATE call_logs
            SET duration        = $2,
                start_time      = COALESCE($3, start_time),
                end_time        = $4,
                latitude        = COALESCE($5, latitude),
                longitude       = COALESCE($6, longitude),
                accuracy_meters = COALESCE($7, accuracy_meters),
                status          = $8,
                to_number       = COALESCE(to_number, $9),
                from_number     = COALESCE(from_number, $10)
          WHERE id = $1
        RETURNING id`,
        [
          pendingId,
          durationSec,
          startTime,
          endTime,
          lat,
          lng,
          accuracy,
          statusStr,
          toNumber || null,
          fromNumber || null,
        ]
      );
      callLogId = updated.rows[0].id;
      console.log('[callback] updated pending call_log', {
        id: callLogId,
        qr_id: qrId,
        has_location: lat != null && lng != null,
      });
    } else {
      const inserted = await pool.query(
        `INSERT INTO call_logs
           (qr_id, to_number, from_number, call_sid,
            duration, start_time, end_time,
            latitude, longitude, accuracy_meters,
            status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (call_sid) DO UPDATE
           SET duration        = EXCLUDED.duration,
               end_time        = EXCLUDED.end_time,
               latitude        = COALESCE(call_logs.latitude, EXCLUDED.latitude),
               longitude       = COALESCE(call_logs.longitude, EXCLUDED.longitude),
               accuracy_meters = COALESCE(call_logs.accuracy_meters, EXCLUDED.accuracy_meters),
               status          = EXCLUDED.status
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
          statusStr,
        ]
      );
      callLogId = inserted.rows[0].id;
      console.log('[callback] inserted call_log (no pending row)', {
        id: callLogId,
        qr_id: qrId,
        has_location: lat != null && lng != null,
        unattributed: !qrId,
      });
    }

    if (!qrId) {
      console.warn(
        '[callback] UNATTRIBUTED — no pending row and no caller_activity match. ' +
          `from=${fromNumber} to=${toNumber} sid=${callSid}. ` +
          'call_logs row exists but qr_id is NULL.'
      );
    }

    // Fire-and-forget push: "the call is over, here's the outcome". Only
    // fires when we could attribute the call to a QR owner. Body varies
    // by outcome so the notification is worth reading at a glance:
    //   • answered → "1m 24s call with 98****3210"
    //   • missed   → "Missed call from 98****3210"
    if (qrId) {
      try {
        const ownerRes = await pool.query(
          `SELECT q.user_id, q.vehicle_number
             FROM qrdata q WHERE q.id = $1`,
          [qrId]
        );
        const userId = ownerRes.rows[0]?.user_id;
        const vehicle = ownerRes.rows[0]?.vehicle_number || '';
        if (userId) {
          const answered = (durationSec ?? 0) > 0;
          const masked = fromNumber ? maskMobile(fromNumber) : 'Unknown';
          const durText = answered
            ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
            : '';
          const vLabel = vehicle ? ` (${vehicle})` : '';
          notifyUser(userId, {
            title: answered ? 'Call completed' : 'Missed call on your QR',
            message: answered
              ? `${durText} call with ${masked}${vLabel}.`
              : `${masked} tried to reach your emergency contacts${vLabel}.`,
            type: answered ? 'qr_call_completed' : 'qr_call_missed',
            data: {
              qr_id: qrId,
              call_log_id: callLogId,
              from_number: fromNumber,
              duration: durationSec,
            },
          }).catch((e) =>
            console.error('[callback] notifyUser rejected:', e)
          );
        }
      } catch (err) {
        console.error('[callback] owner lookup failed:', err.message);
      }
    }

    return res.json({ ok: true, call_log_id: callLogId });
  } catch (err) {
    console.error('[callback] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Parse an incoming timestamp from Exotel. Returns null for anything that
// isn't a real call time — including Unix epoch 0 (which shows up as
// 1970-01-01 in Postgres) when Exotel forwards a missing/zero value.
function parseTs(v) {
  if (v == null || v === '') return null;
  // Numeric strings → Unix seconds/ms.
  const numMatch = typeof v === 'string' && /^\d+$/.test(v);
  let d;
  if (typeof v === 'number' || numMatch) {
    const n = Number(v);
    // Values less than 1e12 are seconds, otherwise milliseconds.
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    d = new Date(v);
  }
  if (Number.isNaN(d.getTime())) return null;
  // Anything older than 2020 is a call-log timestamp bug — reject it so
  // NULL lands in the DB instead of 1970-01-01.
  if (d.getUTCFullYear() < 2020) return null;
  return d.toISOString();
}

export default router;
