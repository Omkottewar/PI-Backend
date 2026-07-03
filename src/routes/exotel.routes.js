import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();

// How long a bystander's selection stays "live" for the IVR. Matches the
// TTL displayed in the alert page's dial modal.
const SELECTION_TTL_MINUTES = 30;

// GET /exotel/lookup?digits=XXXXX
//   Called by the Exotel IVR after the scanner types the QR's 5-digit
//   extension code. Returns the real phone number of the contact the
//   bystander tapped on the alert page — as text/plain, no JSON, no quotes.
//   Returns 404 with an empty body if:
//     - the digits don't map to any active QR
//     - no contact has been selected yet
//     - the selection is older than SELECTION_TTL_MINUTES
//   Falls back to the owner's mobile if the selected family contact was
//   deleted after selection (FK SET NULL on family_details).
router.get('/lookup', async (req, res) => {
  const digits = String(req.query.digits || '').trim();
  const { CallSid, CallFrom } = req.query;

  console.log('[exotel/lookup]', { CallSid, CallFrom, digits });

  if (!digits) {
    return res.status(404).type('text/plain').send('');
  }

  try {
    const result = await pool.query(
      `SELECT
         q.id,
         q.mobile             AS owner_mobile,
         q.selected_contact_kind,
         q.selected_family_id,
         q.selected_at,
         f.phone              AS family_phone
       FROM qrdata q
       LEFT JOIN family_details f ON f.id = q.selected_family_id
       WHERE q.digits = $1 AND q.is_active = true`,
      [digits]
    );

    if (!result.rows.length) {
      return res.status(404).type('text/plain').send('');
    }

    const row = result.rows[0];

    // Selection must exist.
    if (!row.selected_contact_kind || !row.selected_at) {
      return res.status(404).type('text/plain').send('');
    }

    // Selection must still be within the 30-minute TTL.
    const ageMinutes =
      (Date.now() - new Date(row.selected_at).getTime()) / (1000 * 60);
    if (ageMinutes > SELECTION_TTL_MINUTES) {
      return res.status(404).type('text/plain').send('');
    }

    // Resolve the target. If the pointer said 'family' but the family row
    // was deleted (family_phone is null via LEFT JOIN + FK SET NULL), fall
    // back to the owner's mobile.
    let target;
    if (row.selected_contact_kind === 'family' && row.family_phone) {
      target = row.family_phone;
    } else {
      target = row.owner_mobile;
    }

    return res.type('text/plain').send(String(target || ''));
  } catch (err) {
    console.error('[exotel/lookup] error:', err);
    return res.status(500).type('text/plain').send('');
  }
});

export default router;
