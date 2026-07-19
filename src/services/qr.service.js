import { randomUUID } from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { verifyPaymentSignature } from './razorpay.service.js';
import { sendInvoiceEmail } from './mail.service.js';
import { sendQrCreated } from './sms.service.js';
import { markPaymentVerified, markPaymentFailed } from './payment.service.js';

// Client-facing relation groups. Stored verbatim in family_details.relation.
// Grouped as slash-pairs so the mobile UI can show 5 buttons instead of 9
// separate radios. Migration 018 rewrites legacy singular values.
const RELATIONS = new Set([
  'Father/Mother',
  'Sister/Brother',
  'Husband/Wife',
  'Son/Daughter',
  'Other',
]);

export function validateFamilyRelation(relation) {
  return RELATIONS.has(relation);
}

export async function createQrRecord({
  userId,
  uniqueId: providedUniqueId,
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
  name,
  mobile,
  email,
  vehicle_number,
  blood_group,
  family,
  isManual = false,
  preAllocatedDigits = null,          // used by manual-activate path
  referral_code = null,                // used by manual-activate path
  shipping_address_line1 = null,
  shipping_address_line2 = null,
  shipping_city = null,
  shipping_state = null,
  shipping_pincode = null,
  shipping_country = null,
}) {
  // Verify the Razorpay HMAC BEFORE any DB writes. Manual activations
  // pass 'manual' sentinel strings (see alert.routes.js manual_activate)
  // and bypass this — those flow through referral-code auth instead.
  const isManualBypass =
    razorpay_order_id === 'manual' &&
    razorpay_payment_id === 'manual' &&
    razorpay_signature === 'manual';

  // Idempotency check — if this exact razorpay_order_id was already
  // used to successfully create a QR, return that QR instead of trying
  // again. This handles the "response lost in transit" scenario where
  // the backend committed the QR but the network dropped before the
  // client saw the response — the client retries, we recognize the
  // order, and hand back the existing QR. Prevents:
  //   - Duplicate 400s from the vehicle-number UNIQUE constraint
  //   - Double-charge fear ("did my payment go through?")
  //   - Manual refunds for what were actually successful transactions
  if (!isManualBypass && razorpay_order_id) {
    try {
      const idem = await pool.query(
        `SELECT q.*
           FROM payments p
           JOIN qrdata q ON q.id = p.qr_id
          WHERE p.razorpay_order_id = $1
            AND p.status = 'verified'
            AND p.user_id = $2
          LIMIT 1`,
        [razorpay_order_id, userId]
      );
      if (idem.rows.length) {
        const existing = idem.rows[0];
        const alertUrl = `${config.publicAppUrl}/alert/${existing.unique_id}?digits=${existing.digits}`;
        console.log(`[qr/create] idempotent hit for order=${razorpay_order_id} → qr_id=${existing.id}`);
        return { ...existing, alertUrl };
      }
    } catch (err) {
      // Idempotency check is best-effort — if it fails (e.g., payments
      // table doesn't exist yet), fall through to the normal path.
      console.warn('[qr/create] idempotency check skipped:', err.message);
    }
  }

  // Second idempotency layer: the Razorpay webhook may have already
  // HMAC-verified this payment (event=payment.captured) but the client-
  // side Razorpay SDK reported failure/timeout to the phone (very common
  // for UPI Collect when NPCI is slow). In that case:
  //   - payments.status is 'verified' with a razorpay_payment_id
  //   - payments.qr_id is NULL because the QR was never created client-side
  //   - the client can't pass a razorpay_signature because it never got one
  // Trust the webhook (it's HMAC'd with our shared secret, only Razorpay
  // could have produced it) and continue QR creation without re-checking
  // the client-provided signature. Pull the payment_id from the DB row.
  let effectivePaymentId = razorpay_payment_id;
  let webhookTrusted = false;
  if (!isManualBypass && razorpay_order_id) {
    try {
      const wh = await pool.query(
        `SELECT razorpay_payment_id
           FROM payments
          WHERE razorpay_order_id = $1
            AND user_id = $2
            AND status = 'verified'
          LIMIT 1`,
        [razorpay_order_id, userId]
      );
      if (wh.rows.length && wh.rows[0].razorpay_payment_id) {
        webhookTrusted = true;
        effectivePaymentId = wh.rows[0].razorpay_payment_id;
        console.log(
          `[qr/create] trusting webhook-verified payment order=${razorpay_order_id} payment=${effectivePaymentId} — skipping client signature check`
        );
      }
    } catch (err) {
      console.warn('[qr/create] webhook-trust lookup skipped:', err.message);
    }
  }

  if (!isManualBypass && !webhookTrusted) {
    if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      // Record the failed attempt for reconciliation, then reject.
      markPaymentFailed({
        razorpayOrderId: razorpay_order_id,
        errorMessage: 'signature_mismatch',
      });
      const err = new Error('Invalid payment signature');
      err.statusCode = 400;
      throw err;
    }
  }

  if (!family || !Array.isArray(family) || family.length < 1 || family.length > 5) {
    const err = new Error('Family must include 1 to 5 contacts');
    err.statusCode = 400;
    throw err;
  }

  for (const f of family) {
    if (!f.name || !f.phone || !f.relation || !validateFamilyRelation(f.relation)) {
      const err = new Error('Each family member needs name, phone, and valid relation');
      err.statusCode = 400;
      throw err;
    }
  }

  const vehicleNorm = String(vehicle_number).trim().toUpperCase();
  const existingQr = await getQrByVehicleNumber(vehicleNorm);
  if (existingQr) {
    const err = new Error('Vehicle number already registered');
    err.statusCode = 400;
    throw err;
  }

  const uniqueId = providedUniqueId || randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Digit allocation strategy:
    //   - Manual QR activation: use the digits pre-allocated on manual_qr
    //     at MINT time. Physical stickers are already printed with them.
    //   - Auto (paid) QR: allocate a fresh value from qrdata_digits_auto_seq.
    //   - Everything else (defensive): fall back to allocating from the
    //     appropriate sequence.
    let digits = preAllocatedDigits;
    if (!digits) {
      const sequenceName = isManual ? 'qrdata_digits_manual_seq' : 'qrdata_digits_auto_seq';
      try {
        const seqRes = await client.query(
          `SELECT nextval('${sequenceName}')::text AS digits`
        );
        digits = seqRes.rows[0].digits;
      } catch (e) {
        if (String(e.message || '').toLowerCase().includes('reached maximum value')) {
          const bucket = isManual ? 'manual (70000-999999)' : 'auto (10000-69999)';
          const err = new Error(`QR short-code space exhausted for ${bucket}`);
          err.statusCode = 503;
          throw err;
        }
        throw e;
      }
    }

    const qrRes = await client.query(
      `INSERT INTO qrdata (
         user_id, unique_id, name, mobile, email,
         vehicle_number, blood_group, digits, is_manual, referral_code,
         shipping_address_line1, shipping_address_line2,
         shipping_city, shipping_state, shipping_pincode, shipping_country
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        userId, uniqueId, name.trim(), mobile.trim(), email.trim(),
        vehicleNorm, blood_group || null, digits, isManual,
        referral_code ? String(referral_code).trim() : null,
        shipping_address_line1 ? String(shipping_address_line1).trim() : null,
        shipping_address_line2 ? String(shipping_address_line2).trim() : null,
        shipping_city ? String(shipping_city).trim() : null,
        shipping_state ? String(shipping_state).trim() : null,
        shipping_pincode ? String(shipping_pincode).trim() : null,
        shipping_country ? String(shipping_country).trim() : 'India',
      ]
    );
    const qr = qrRes.rows[0];

    // Backfill users row from the QR form input. COALESCE so we only fill
    // fields the user hasn't already set elsewhere — never overwrite an
    // existing profile value. Fixes the empty-Profile-tab bug where a
    // user who created a QR still saw NULL name/email on the Profile tab
    // because those fields only landed in qrdata (denormalized snapshot).
    await client.query(
      `UPDATE users
          SET name  = COALESCE(users.name,  $2),
              email = COALESCE(NULLIF(users.email, ''), NULLIF($3, ''))
        WHERE id = $1`,
      [userId, name.trim(), email.trim()]
    );

    for (const f of family) {
      await client.query(
        `INSERT INTO family_details (qr_id, name, phone, relation) VALUES ($1, $2, $3, $4)`,
        [qr.id, f.name.trim(), String(f.phone).replace(/\s/g, ''), f.relation]
      );
    }
    await client.query('COMMIT');
    const alertUrl = `${config.publicAppUrl}/alert/${uniqueId}?digits=${qr.digits}`;

    // Link the payment audit row to the freshly-created QR and mark
    // the payment as verified. Manual activations skip this — they
    // never had a Razorpay order in the first place.
    if (!isManualBypass) {
      markPaymentVerified({
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: effectivePaymentId,
        razorpaySignature: razorpay_signature,
        qrId: qr.id,
      });
    }

    // Fire-and-forget invoice email. Errors are swallowed inside the
    // service so a flaky SMTP never masks a successful activation. We
    // don't await it — the caller sees the response the moment the DB
    // row is committed.
    sendInvoiceEmail(qr, family).catch((e) =>
      console.error('[qr/service] sendInvoiceEmail rejected unexpectedly:', e)
    );

    // Fire-and-forget SMS: "Your QR for MHXXXX (owner ...) is generated,
    // sticker in 3-5 days". Deliberately sent to the OWNER mobile stored
    // on the QR row (which for manual activations is the person who
    // scratched the sticker, not the user's login mobile).
    sendQrCreated({
      mobile: qr.mobile,
      vehicle_number: qr.vehicle_number,
      owner_number: qr.mobile,
    }).catch((e) =>
      console.error('[qr/service] sendQrCreated rejected unexpectedly:', e)
    );

    return { ...qr, alertUrl };
  } catch (e) {
    await client.query('ROLLBACK');
    // Postgres unique-violation code — the vehicle_number UNIQUE index
    // from migration 021 fires here under a concurrent submit race.
    // Convert the raw DB error into a user-friendly 400 AND record the
    // payment as failed so the customer's Razorpay charge is visible
    // for manual refund reconciliation.
    if (e && e.code === '23505') {
      if (!isManualBypass && razorpay_order_id) {
        markPaymentFailed({
          razorpayOrderId: razorpay_order_id,
          errorMessage: 'vehicle_number_conflict_after_payment',
        });
      }
      const err = new Error('Vehicle number already registered. If you were just charged, contact support with your payment ID for a refund.');
      err.statusCode = 400;
      throw err;
    }
    // Any other post-signature failure is even worse — customer paid,
    // our end broke. Mark it for the reconciliation cron to pick up.
    if (!isManualBypass && razorpay_order_id) {
      markPaymentFailed({
        razorpayOrderId: razorpay_order_id,
        errorMessage: `post_payment_error: ${e.message || 'unknown'}`,
      });
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function listHistoryForUser(userId) {
  const res = await pool.query(
    `SELECT q.id, q.unique_id, q.digits, q.name, q.mobile, q.email, q.vehicle_number, q.blood_group, q.created_at, q.is_active, q.is_manual, q.date_of_activation,
            (SELECT COUNT(*)::int FROM family_details f WHERE f.qr_id = q.id) AS family_count
     FROM qrdata q
     WHERE q.user_id = $1
     ORDER BY q.created_at DESC`,
    [userId]
  );
  return res.rows.map((row) => ({
    ...row,
    alert_url: `${config.publicAppUrl}/alert/${row.unique_id}?digits=${row.digits}`,
  }));
}

export async function getQrByUniqueId(uniqueId) {
  const res = await pool.query(`SELECT * FROM qrdata WHERE unique_id = $1`, [uniqueId]);
  return res.rows[0] || null;
}

export async function getQrByVehicleNumber(vehicleNumber) {
  const vehicleNorm = String(vehicleNumber).trim().toUpperCase();
  const res = await pool.query(`SELECT * FROM qrdata WHERE vehicle_number = $1`, [vehicleNorm]);
  return res.rows[0] || null;
}

export async function getFamilyByQrId(qrId) {
  const res = await pool.query(
    `SELECT * FROM family_details WHERE qr_id = $1 ORDER BY id`,
    [qrId]
  );
  return res.rows;
}

export async function getFamilyMember(qrId, familyDetailId) {
  const res = await pool.query(
    `SELECT * FROM family_details WHERE qr_id = $1 AND id = $2`,
    [qrId, familyDetailId]
  );
  return res.rows[0] || null;
}

async function assertQrOwnedByUser(qrId, userId) {
  const res = await pool.query(
    `SELECT id FROM qrdata WHERE id = $1 AND user_id = $2`,
    [qrId, userId]
  );
  if (!res.rows.length) {
    const err = new Error('QR not found');
    err.statusCode = 404;
    throw err;
  }
}

export async function getFamilyForUserQr(userId, qrId) {
  await assertQrOwnedByUser(qrId, userId);
  return getFamilyByQrId(qrId);
}

export async function replaceFamilyForUserQr(userId, qrId, family) {
  await assertQrOwnedByUser(qrId, userId);

  if (!Array.isArray(family) || family.length < 1 || family.length > 5) {
    const err = new Error('Family must include 1 to 5 contacts');
    err.statusCode = 400;
    throw err;
  }
  for (const f of family) {
    if (!f.name || !f.phone || !f.relation || !validateFamilyRelation(f.relation)) {
      const err = new Error('Each family member needs name, phone, and valid relation');
      err.statusCode = 400;
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM family_details WHERE qr_id = $1`, [qrId]);
    for (const f of family) {
      await client.query(
        `INSERT INTO family_details (qr_id, name, phone, relation) VALUES ($1, $2, $3, $4)`,
        [qrId, f.name.trim(), String(f.phone).replace(/\s/g, ''), f.relation]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return getFamilyByQrId(qrId);
}
