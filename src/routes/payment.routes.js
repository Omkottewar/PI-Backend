import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createOrder, DEFAULT_AMOUNT_PAISE } from '../services/razorpay.service.js';
import { config } from '../config/index.js';
import { getQrByVehicleNumber } from '../services/qr.service.js';
import { recordOrderCreated, getPaymentStatus } from '../services/payment.service.js';

const router = Router();

/** Create Razorpay order for QR subscription (test mode). */
router.post('/razorpay/order', requireAuth, async (req, res) => {
  try {
    const { vehicle_number } = req.body;
    if (!vehicle_number) {
      return res.status(400).json({ error: 'Vehicle number is required for payment validation' });
    }
    const existingQr = await getQrByVehicleNumber(vehicle_number);
    if (existingQr) {
      return res.status(400).json({ error: 'Given Vehicle is already in system' });
    }

    const amount = req.body?.amount_paise ? parseInt(req.body.amount_paise, 10) : DEFAULT_AMOUNT_PAISE;
    const order = await createOrder(Number.isFinite(amount) ? amount : DEFAULT_AMOUNT_PAISE);
    // Fire-and-forget audit row. qr_id is null here — the qrdata row
    // doesn't exist yet; /qr/create will link it after signature verify.
    recordOrderCreated({
      userId: req.userId,
      qrId: null,
      purpose: 'qr_create',
      razorpayOrderId: order.id,
      amountPaise: order.amount,
      intendedAmountPaise: order.intended_amount ?? order.amount,
      currency: order.currency || 'INR',
    });
    return res.json({
      order_id: order.id,
      amount: order.amount,                    // what Razorpay will charge
      intended_amount: order.intended_amount,  // what the UI should display
      currency: order.currency,
      key_id: config.razorpayKeyId || 'rzp_test_dev',
      demo_mode: !config.razorpayKeyId,
    });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message });
  }
});

// ─── GET /payments/status/:orderId ──────────────────────────────────────
// Pending-order recovery. Mobile stores order_id to disk when the
// checkout opens; if the app is killed mid-modal, on relaunch it calls
// this endpoint to figure out whether the payment eventually succeeded
// (so we can skip the retry that would double-charge). Auth-scoped so
// one user can't peek at another's orders.
router.get('/status/:orderId', requireAuth, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });
  try {
    const row = await getPaymentStatus(orderId, req.userId);
    if (!row) {
      // Not our order (or never recorded) — treat as unknown so client
      // can decide to abandon it. Not a 404 because clients would
      // treat 404 as a hard error to surface.
      return res.json({ found: false });
    }
    return res.json({
      found: true,
      status: row.status,                     // 'created' | 'verified' | 'failed'
      qr_id: row.qr_id,
      razorpay_payment_id: row.razorpay_payment_id,
      amount_paise: row.amount_paise,
      intended_amount_paise: row.intended_amount_paise,
      error_message: row.error_message,
      verified_at: row.verified_at,
    });
  } catch (err) {
    console.error('[payments/status] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
