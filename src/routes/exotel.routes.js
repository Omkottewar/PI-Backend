import { Router } from 'express';
import { pool } from '../db/pool.js';
import { normalizeIndianMobile } from '../utils/phone.js';

const router = Router();

const SELECTION_TTL_MINUTES = 30;
const SPAM_NOTIFY_THRESHOLD = 5;

const BRIDGE_NUMBER = '02048563508';
const MAX_RINGING_DURATION_SEC = 45;
const MAX_CONVERSATION_DURATION_SEC = 120;
const RECORD_CALLS = true;

// Build the JSON payload the Exotel Connect (Fetch destination from URL)
// applet expects. `numbers` = [] means "no target — hang up", which is what
// we return for a blocked caller.
function exotelResponse(numbers) {
  return {
    fetch_after_attempt: false,
    destination: { numbers },
    outgoing_phone_number: BRIDGE_NUMBER,
    record: RECORD_CALLS,
    recording_channels: 'dual',
    max_ringing_duration: MAX_RINGING_DURATION_SEC,
    max_conversation_duration: MAX_CONVERSATION_DURATION_SEC,
    music_on_hold: { type: 'operator_tone' },
    start_call_playback: {
      playback_to: 'both',
      type: 'text',
      value:
        'Connecting your emergency call through QR 4 Emergency. ' +
        'Please stay on the line.',
    },
    parallel_ringing: {
      activate: false,
      max_parallel_attempts: 1,
    },
  };
}

// GET /exotel/lookup?digits=XXXXX&CallFrom=+91NNNNNNNNNN&CallSid=...
//
// Order of operations:
//   1. Resolve QR from digits and figure out the intended target number.
//   2. UPSERT caller_activity keyed by (qr_id, from_number). Stamp the
//      current to_number and CallSid on the row.
//   3. If the row is blocked → return HTTP 200 with destination.numbers=[]
//      (Exotel Connect hangs up gracefully).
//   4. Otherwise validate the selection (must exist, must be < 30 min old)
//      and return HTTP 200 with destination.numbers=[E.164 target].
//   5. Any non-block failure returns HTTP 404 with a small JSON body —
//      Exotel's Passthru "on failure" branch should point at a
//      "no active contact" playback + hangup applet.
router.get('/lookup', async (req, res) => {
  // Exotel sometimes URL-encodes the gathered digits WITH quotes around
  // them (e.g. digits='"10013"' instead of '10013') when it substitutes
  // variables into the Passthru URL template. Strip everything that isn't
  // a digit so we compare cleanly against qrdata.digits.
  const digitsRaw = String(req.query.digits || '').trim();
  const digits = digitsRaw.replace(/\D/g, '');
  const callSid = String(req.query.CallSid || '').trim();
  const callerNumberRaw = String(req.query.CallFrom || '').trim();
  const fromNumber = normalizeIndianMobile(callerNumberRaw);

  console.log('[exotel/lookup]', {
    CallSid: callSid,
    CallFrom: fromNumber,
    digits,
    digitsRaw: digitsRaw !== digits ? digitsRaw : undefined,
  });

  if (!digits) {
    return res.status(404).json({ error: 'digits required' });
  }

  try {
    const result = await pool.query(
      `SELECT
         q.id,
         q.mobile              AS owner_mobile,
         q.selected_contact_kind,
         q.selected_family_id,
         q.selected_at,
         f.phone               AS family_phone
       FROM qrdata q
       LEFT JOIN family_details f ON f.id = q.selected_family_id
       WHERE q.digits = $1 AND q.is_active = true`,
      [digits]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'unknown code' });
    }

    const row = result.rows[0];

    // Resolve the intended target so we can stamp it onto caller_activity
    // even before the block/TTL checks. Falls back to owner if the
    // selected family row was deleted.
    let targetRaw;
    if (row.selected_contact_kind === 'family' && row.family_phone) {
      targetRaw = row.family_phone;
    } else {
      targetRaw = row.owner_mobile;
    }
    const toE164 = normalizeIndianMobile(targetRaw);

    // UPSERT caller_activity keyed by (qr_id, from_number).
    // to_number and last_call_sid are updated on every hit so the owner
    // always sees the freshest info in the mobile UI.
    let isBlocked = false;
    if (fromNumber) {
      try {
        const upsert = await pool.query(
          `INSERT INTO caller_activity
             (qr_id, from_number, to_number, last_call_sid,
              call_count, first_call_at, last_call_at)
           VALUES ($1, $2, $3, $4, 1, NOW(), NOW())
           ON CONFLICT (qr_id, from_number) DO UPDATE
             SET call_count    = caller_activity.call_count + 1,
                 to_number     = EXCLUDED.to_number,
                 last_call_sid = COALESCE(EXCLUDED.last_call_sid,
                                          caller_activity.last_call_sid),
                 last_call_at  = NOW()
           RETURNING call_count, is_blocked`,
          [row.id, fromNumber, toE164 || null, callSid || null]
        );
        const activity = upsert.rows[0];
        isBlocked = activity.is_blocked === true;
        if (activity.call_count === SPAM_NOTIFY_THRESHOLD) {
          console.warn(
            `[caller-activity] threshold crossed qr_id=${row.id} ` +
              `from=${fromNumber} count=${activity.call_count}`
          );
        }
      } catch (err) {
        // Tracking must never break the primary routing path.
        console.error('[caller-activity] upsert failed:', err);
      }
    }

    // Blocked: hand Exotel an empty numbers list so its Connect applet
    // hangs up. Still HTTP 200 — Passthru treats non-2xx as an error.
    if (isBlocked) {
      return res.json(exotelResponse([]));
    }

    // Selection must exist and be within TTL for the call to be routed.
    if (!row.selected_contact_kind || !row.selected_at) {
      return res.status(404).json({ error: 'no active selection' });
    }
    const ageMinutes =
      (Date.now() - new Date(row.selected_at).getTime()) / (1000 * 60);
    if (ageMinutes > SELECTION_TTL_MINUTES) {
      return res.status(404).json({ error: 'selection expired' });
    }

    if (!toE164) {
      return res.status(404).json({ error: 'target number malformed' });
    }

    return res.json(exotelResponse([toE164]));
  } catch (err) {
    console.error('[exotel/lookup] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
