import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';
import {
  createQrRecord,
  listHistoryForUser,
  validateFamilyRelation,
  getQrByVehicleNumber,
  getFamilyForUserQr,
  replaceFamilyForUserQr,
} from '../services/qr.service.js';
import { createOrder, verifyPaymentSignature } from '../services/razorpay.service.js';
import { config } from '../config/index.js';
import {
  recordOrderCreated,
  markPaymentVerified,
  markPaymentFailed,
} from '../services/payment.service.js';

const router = Router();

router.get('/check-vehicle/:vehicleNumber', requireAuth, async (req, res) => {
  const { vehicleNumber } = req.params;
  try {
    const row = await getQrByVehicleNumber(vehicleNumber);
    return res.json({ exists: !!row });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post(
  '/create',
  requireAuth,
  body('razorpay_order_id').notEmpty(),
  // payment_id and signature may be empty when the mobile client is
  // recovering from a Razorpay client-side timeout that our webhook has
  // already confirmed server-side. createQrRecord() checks payments.status
  // and pulls the payment_id from the DB in that path.
  body('razorpay_payment_id').isString(),
  body('razorpay_signature').isString(),
  body('name').trim().notEmpty(),
  body('mobile').trim().isLength({ min: 10, max: 15 }),
  // gmail_remove_dots: false — see profile.routes.js for the reason.
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('vehicle_number').trim().notEmpty().matches(/^([A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/).withMessage('Invalid Vehicle Number'),
  body('blood_group').optional().isString().trim(),
  body('family').isArray({ min: 1, max: 5 }),
  body('family.*.name').trim().notEmpty(),
  body('family.*.phone').trim().notEmpty(),
  body('family.*.relation').custom((v) => validateFamilyRelation(v)),
  // Shipping address for the physical sticker.
  body('shipping_address_line1').trim().notEmpty().withMessage('Address is required'),
  body('shipping_address_line2').optional({ nullable: true }).isString().trim(),
  body('shipping_city').trim().notEmpty().withMessage('City is required'),
  body('shipping_state').trim().notEmpty().withMessage('State is required'),
  body('shipping_pincode').trim().matches(/^[0-9]{6}$/).withMessage('Pincode must be 6 digits'),
  body('shipping_country').optional({ nullable: true }).isString().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.warn(`[qr/create] REJECTED — validation user=${req.userId} errors=${JSON.stringify(errors.array())}`);
      return res.status(400).json({ errors: errors.array() });
    }
    const orderId = req.body?.razorpay_order_id;
    const vehicle = req.body?.vehicle_number;
    console.log(`[qr/create] entered user=${req.userId} order=${orderId} vehicle=${vehicle}`);
    try {
      const row = await createQrRecord({
        userId: req.userId,
        ...req.body,
        isManual: false,
      });
      console.log(`[qr/create] OK user=${req.userId} order=${orderId} qr_id=${row.id} vehicle=${row.vehicle_number}`);
      return res.status(201).json({
        id: row.id,
        unique_id: row.unique_id,
        digits: row.digits,
        alert_url: row.alertUrl,
        vehicle_number: row.vehicle_number,
        created_at: row.created_at,
      });
    } catch (e) {
      const code = e.statusCode || 500;
      console.error(`[qr/create] FAILED user=${req.userId} order=${orderId} vehicle=${vehicle} status=${code} err=${e.message}`);
      return res.status(code).json({ error: e.message });
    }
  }
);

router.get('/history', requireAuth, async (req, res) => {
  const rows = await listHistoryForUser(req.userId);
  return res.json({ items: rows });
});

router.get('/:id/family', requireAuth, async (req, res) => {
  const qrId = parseInt(req.params.id, 10);
  if (!Number.isFinite(qrId)) {
    return res.status(400).json({ error: 'Invalid QR id' });
  }
  try {
    const items = await getFamilyForUserQr(req.userId, qrId);
    return res.json({ items });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message });
  }
});

router.put(
  '/:id/family',
  requireAuth,
  body('family').isArray({ min: 1, max: 5 }),
  body('family.*.name').trim().notEmpty(),
  body('family.*.phone').trim().notEmpty(),
  body('family.*.relation').custom((v) => validateFamilyRelation(v)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const qrId = parseInt(req.params.id, 10);
    if (!Number.isFinite(qrId)) {
      return res.status(400).json({ error: 'Invalid QR id' });
    }
    try {
      const items = await replaceFamilyForUserQr(req.userId, qrId, req.body.family);
      return res.json({ items });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ error: e.message });
    }
  }
);

// Owner phone — updates only qrdata.mobile for the QR. Kept separate from
// users.mobile (the login identifier), which we never change here because
// that would break the account's OTP login path. If a user wants to
// update the QR-owner phone (the one that gets called when the bystander
// taps "Call Owner"), this is the endpoint.
router.put(
  '/:id/owner-phone',
  requireAuth,
  body('mobile').trim().notEmpty().isLength({ min: 10, max: 15 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const qrId = parseInt(req.params.id, 10);
    if (!Number.isFinite(qrId)) {
      return res.status(400).json({ error: 'Invalid QR id' });
    }
    try {
      const check = await pool.query(
        `SELECT id FROM qrdata WHERE id = $1 AND user_id = $2`,
        [qrId, req.userId]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'QR not found' });

      const mobile = String(req.body.mobile).trim();
      const r = await pool.query(
        `UPDATE qrdata SET mobile = $1 WHERE id = $2
         RETURNING id, mobile`,
        [mobile, qrId]
      );
      return res.json({ ok: true, mobile: r.rows[0].mobile });
    } catch (err) {
      console.error('[qr/owner-phone] error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─── POST /qr/:id/renew/order ────────────────────────────────────────────
// Creates a Razorpay order for a renewal payment. Owner-only; anyone
// trying to renew someone else's QR gets 404. Order amount comes from
// config.renewal.amountPaise so a promotional rate is one env-var away.
router.post('/:id/renew/order', requireAuth, async (req, res) => {
  const qrId = parseInt(req.params.id, 10);
  console.log(`[qr/renew/order] user=${req.userId} qr_id=${qrId}`);
  if (!Number.isFinite(qrId)) {
    return res.status(400).json({ error: 'Invalid QR id' });
  }
  try {
    const own = await pool.query(
      `SELECT id, vehicle_number FROM qrdata WHERE id = $1 AND user_id = $2`,
      [qrId, req.userId]
    );
    if (!own.rows.length) {
      console.warn(`[qr/renew/order] REJECTED — qr not found or not owned user=${req.userId} qr_id=${qrId}`);
      return res.status(404).json({ error: 'QR not found' });
    }

    const amount = config.renewal.amountPaise;
    const order = await createOrder(amount, `renew_${qrId}_${Date.now()}`);
    // Renewal already knows the qr_id, so link it immediately.
    recordOrderCreated({
      userId: req.userId,
      qrId,
      purpose: 'qr_renew',
      razorpayOrderId: order.id,
      amountPaise: order.amount,
      intendedAmountPaise: order.intended_amount ?? order.amount,
      currency: order.currency || 'INR',
    });
    console.log(`[qr/renew/order] OK user=${req.userId} qr_id=${qrId} order=${order.id} amount=${order.amount}`);
    return res.json({
      order_id: order.id,
      amount: order.amount,                    // what Razorpay will charge
      intended_amount: order.intended_amount,  // what the UI should display
      currency: order.currency || 'INR',
      key_id: config.razorpayKeyId || 'rzp_test_dev',
      qr_id: qrId,
      vehicle_number: own.rows[0].vehicle_number,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    console.error(`[qr/renew/order] FAILED user=${req.userId} qr_id=${qrId} status=${code} err=${err.message}`);
    return res.status(code).json({ error: err.message });
  }
});

// ─── POST /qr/:id/renew/verify ───────────────────────────────────────────
// Verifies the Razorpay signature and extends the QR's date_of_activation
// by one year. Extension is calculated as GREATEST(existing + 1 year, now)
// so a user renewing before expiry keeps their remaining days; a user
// renewing after expiry gets a fresh 365 days from now. Also flips
// is_active back on in case the scheduler already turned it off.
router.post(
  '/:id/renew/verify',
  requireAuth,
  body('razorpay_order_id').notEmpty(),
  body('razorpay_payment_id').notEmpty(),
  body('razorpay_signature').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const qrId = parseInt(req.params.id, 10);
    if (!Number.isFinite(qrId)) {
      return res.status(400).json({ error: 'Invalid QR id' });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Idempotency — if this order was already used to renew this QR
    // (either because a prior response was lost or because Razorpay
    // retried its own callback), return the current QR state instead
    // of running the UPDATE again.
    try {
      const idem = await pool.query(
        `SELECT q.id, q.vehicle_number, q.is_active, q.date_of_activation
           FROM payments p
           JOIN qrdata q ON q.id = p.qr_id
          WHERE p.razorpay_order_id = $1
            AND p.status = 'verified'
            AND p.user_id = $2
            AND p.qr_id = $3
          LIMIT 1`,
        [razorpay_order_id, req.userId, qrId]
      );
      if (idem.rows.length) {
        const row = idem.rows[0];
        console.log(`[qr/renew/verify] idempotent hit for order=${razorpay_order_id}`);
        return res.json({
          ok: true,
          qr_id: row.id,
          vehicle_number: row.vehicle_number,
          is_active: row.is_active,
          date_of_activation: row.date_of_activation,
        });
      }
    } catch (err) {
      console.warn('[qr/renew/verify] idempotency check skipped:', err.message);
    }

    if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      markPaymentFailed({
        razorpayOrderId: razorpay_order_id,
        errorMessage: 'signature_mismatch',
      });
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Wrap the ownership check + UPDATE in a single transaction with a
    // row-level lock so a concurrent delete can't yank the qrdata row
    // between our SELECT and UPDATE. Without this, a paid customer
    // could get a 404 while their ₹99 is already gone.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const own = await client.query(
        `SELECT id FROM qrdata
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [qrId, req.userId]
      );
      if (!own.rows.length) {
        await client.query('ROLLBACK');
        // Payment was collected but the QR is gone. Mark the audit row
        // so admin knows to refund.
        markPaymentFailed({
          razorpayOrderId: razorpay_order_id,
          errorMessage: 'qr_deleted_before_renewal_verify',
        });
        return res.status(404).json({ error: 'QR not found — this payment needs a manual refund. Contact support with your payment ID.' });
      }

      const r = await client.query(
        `UPDATE qrdata
            SET is_active = true,
                date_of_activation = GREATEST(
                  COALESCE(date_of_activation, NOW()) + INTERVAL '1 year',
                  NOW()
                )
          WHERE id = $1
          RETURNING id, vehicle_number, is_active, date_of_activation`,
        [qrId]
      );
      await client.query('COMMIT');
      const row = r.rows[0];
      // Mark the payment as verified now that the QR renewal succeeded.
      markPaymentVerified({
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        qrId: row.id,
      });
      console.log(`[qr/renew/verify] user=${req.userId} qr_id=${qrId} new_activation=${row.date_of_activation}`);
      return res.json({
        ok: true,
        qr_id: row.id,
        vehicle_number: row.vehicle_number,
        is_active: row.is_active,
        date_of_activation: row.date_of_activation,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Customer's card was already charged before we got here. Mark
      // the payment as failed so the daily orphaned-payment report
      // catches it for manual refund.
      markPaymentFailed({
        razorpayOrderId: razorpay_order_id,
        errorMessage: `renew_verify_error: ${err.message}`,
      });
      console.error('[qr/renew/verify] error:', err);
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ─── DELETE /qr/:id ──────────────────────────────────────────────────────
// Owner-initiated hard delete. Wipes every row tied to this QR — the
// qrdata row itself, its family_details, alert_events, call_logs, and
// caller_activity — but leaves the users row untouched (an owner may
// still hold other QRs on the same account). If the QR was a manual
// activation we ALSO recycle the manual_qr sticker (is_active=false,
// used=false) so admins see it back in the "deactivated" bucket rather
// than "used" — same treatment as a lost/recalled sticker.
router.delete('/:id', requireAuth, async (req, res) => {
  const qrId = parseInt(req.params.id, 10);
  if (!Number.isFinite(qrId)) {
    return res.status(400).json({ error: 'Invalid QR id' });
  }
  const client = await pool.connect();
  try {
    // Ownership check first — refuse to delete anyone else's QR even if
    // an attacker guesses the id. Also grab is_manual + unique_id so we
    // can recycle the sticker in the same transaction.
    const check = await client.query(
      `SELECT id, unique_id, is_manual FROM qrdata WHERE id = $1 AND user_id = $2`,
      [qrId, req.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'QR not found' });
    const { unique_id, is_manual } = check.rows[0];

    await client.query('BEGIN');
    // Order matters: children before parents so a missing ON DELETE
    // CASCADE on any of these FKs doesn't strand rows.
    await client.query(`DELETE FROM call_logs WHERE qr_id = $1`, [qrId]);
    await client.query(`DELETE FROM caller_activity WHERE qr_id = $1`, [qrId]);
    await client.query(`DELETE FROM alert_events WHERE qr_id = $1`, [qrId]);
    await client.query(`DELETE FROM family_details WHERE qr_id = $1`, [qrId]);
    await client.query(`DELETE FROM qrdata WHERE id = $1`, [qrId]);
    // Recycle the manual sticker so the admin panel shows it as
    // "deactivated" rather than "used" — the customer explicitly walked
    // away from it, so treat it the same as a recalled sticker.
    if (is_manual) {
      await client.query(
        `UPDATE manual_qr
            SET is_active = false, used = false
          WHERE qr_unique_id = $1`,
        [unique_id]
      );
    }
    await client.query('COMMIT');
    console.log(`[qr/delete] user=${req.userId} qr_id=${qrId} manual=${is_manual}`);
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[qr/delete] error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
