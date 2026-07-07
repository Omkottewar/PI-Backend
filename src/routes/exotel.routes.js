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

// Exotel's Connect applet caps parallel ringing at 5 numbers per call.
const MAX_PARALLEL_ATTEMPTS = 5;

// Build the JSON payload the Exotel Connect (Fetch destination from URL)
// applet expects. `numbers` = [] means "no target — hang up", which is
// what we return for a blocked caller. When multiple numbers are given,
// parallel_ringing is turned on so Exotel rings them all at once and
// bridges to whoever picks up first.
function exotelResponse(numbers) {
  const list = Array.isArray(numbers) ? numbers.slice(0, MAX_PARALLEL_ATTEMPTS) : [];
  return {
    fetch_after_attempt: false,
    destination: { numbers: list },
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
      activate: list.length > 1,
      max_parallel_attempts: Math.max(list.length, 1),
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
    // One JOIN: pull the QR row plus every family_details phone in a
    // single JSON aggregate so we can build a parallel-ringing list.
    const result = await pool.query(
      `SELECT
         q.id,
         q.mobile              AS owner_mobile,
         q.selected_contact_kind,
         q.selected_family_id,
         q.selected_at,
         COALESCE(
           (SELECT json_agg(json_build_object('id', f.id, 'phone', f.phone)
                            ORDER BY f.id)
              FROM family_details f WHERE f.qr_id = q.id),
           '[]'::json
         ) AS family_contacts
       FROM qrdata q
       WHERE q.digits = $1 AND q.is_active = true`,
      [digits]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'unknown code' });
    }

    const row = result.rows[0];
    const family = Array.isArray(row.family_contacts) ? row.family_contacts : [];

    // Build the ringing list: selected contact first (so it's the primary
    // target for tracking / caller_activity attribution), then every
    // other contact from the QR — owner + all other family — in an order
    // that puts the most-relevant number first for Exotel's parallel ring.
    const numbers = [];
    const push = (raw) => {
      const e = normalizeIndianMobile(raw);
      if (e && !numbers.includes(e)) numbers.push(e);
    };

    // The single "primary target" we stamp onto caller_activity + the
    // pending call_logs row. Defaults to owner if nothing is selected or
    // the selected family row is gone.
    let primaryTargetRaw = row.owner_mobile;
    if (row.selected_contact_kind === 'family' && row.selected_family_id != null) {
      const selected = family.find((f) => f.id === row.selected_family_id);
      if (selected && selected.phone) primaryTargetRaw = selected.phone;
      // Selected first, then all other family, then owner.
      push(primaryTargetRaw);
      for (const f of family) {
        if (f.id !== row.selected_family_id) push(f.phone);
      }
      push(row.owner_mobile);
    } else {
      // Owner selected (or no selection). Owner first, then all family.
      push(row.owner_mobile);
      for (const f of family) push(f.phone);
    }
    const toE164 = normalizeIndianMobile(primaryTargetRaw);

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

    if (!toE164 || numbers.length === 0) {
      return res.status(404).json({ error: 'no target numbers' });
    }

    // Insert a "pending" call_logs row keyed by call_sid. The completion
    // webhook UPDATEs this same row by call_sid, giving us race-free
    // attribution even when a caller dials multiple contacts rapidly.
    // ON CONFLICT DO NOTHING handles Exotel Passthru retries idempotently.
    // The `to_number` we stamp is the PRIMARY target (selected or owner) —
    // the same number that appears first in the parallel-ring list.
    if (callSid) {
      try {
        await pool.query(
          `INSERT INTO call_logs
             (qr_id, to_number, from_number, call_sid, start_time, status)
           VALUES ($1, $2, $3, $4, NOW(), 'in-progress')
           ON CONFLICT (call_sid) DO NOTHING`,
          [row.id, toE164, fromNumber, callSid]
        );
      } catch (err) {
        // Never break the routing path over a logging failure.
        console.error('[exotel/lookup] pending call_log insert failed:', err);
      }
    }

    console.log('[exotel/lookup] returning numbers', numbers);
    return res.json(exotelResponse(numbers));
  } catch (err) {
    console.error('[exotel/lookup] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
