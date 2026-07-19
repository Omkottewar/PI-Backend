import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

const router = Router();

// Razorpay webhook receiver — the fix for the "UPI Collect timed out"
// class of failures. Razorpay's checkout SDK fires EVENT_PAYMENT_ERROR
// on the customer's device when NPCI takes too long to confirm a UPI
// collect. But if NPCI eventually completes the transfer (minutes or
// hours later), Razorpay POSTs `payment.captured` here — that's how
// we learn the payment actually went through despite the client's
// failure event.
//
// Setup checklist:
//   1. Dashboard → Settings → Webhooks → Create Webhook
//   2. URL: https://pi-backend-qkjh.onrender.com/api/razorpay/webhook
//   3. Secret: any random 32-char string; paste into
//      RAZORPAY_WEBHOOK_SECRET env var on Render
//   4. Events: at minimum tick payment.captured, payment.failed,
//      payment.authorized
//   5. Save. Razorpay will send test events; check Render logs for
//      `[razorpay/webhook]` markers to confirm they land.

// Razorpay signs the webhook body with HMAC-SHA256. We compute the
// same HMAC on our side and compare with what they sent. Timing-safe
// so a hostile probe can't infer the secret from response latency.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = config.razorpayWebhookSecret;
  if (!secret) return false;
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signatureHeader), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

// app.js mounts express.raw() on this path BEFORE express.json(), so
// req.body arrives as a Buffer with the exact bytes Razorpay signed.
// We HMAC over those bytes, then JSON.parse for the payload.
router.post(
  '/webhook',
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (typeof req.body === 'string' ? req.body : '');
    const sig = req.headers['x-razorpay-signature'];
    const ok = verifyWebhookSignature(rawBody, sig);
    if (!ok) {
      console.warn(`[razorpay/webhook] REJECTED — bad or missing signature ip=${req.ip}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (err) {
      console.warn('[razorpay/webhook] REJECTED — malformed JSON:', err.message);
      return res.status(400).json({ error: 'Malformed JSON' });
    }

    const event = payload?.event || 'unknown';
    // Razorpay's payload nests the actual object under a container:
    //   payload.payment.entity      for payment.* events
    //   payload.order.entity        for order.* events
    const payment = payload?.payload?.payment?.entity || null;
    const order = payload?.payload?.order?.entity || null;

    const orderId = payment?.order_id || order?.id || null;
    const paymentId = payment?.id || null;
    const amount = payment?.amount || null;

    console.log(
      `[razorpay/webhook] event=${event} order=${orderId || '(none)'} payment=${paymentId || '(none)'} ` +
      `amount=${amount || '-'} status=${payment?.status || '-'} method=${payment?.method || '-'}`
    );

    try {
      switch (event) {
        case 'payment.captured':
          await handlePaymentCaptured(payment, orderId);
          break;
        case 'payment.authorized':
          // Authorized = money held but not captured. Log so we can see
          // it — we DON'T mark as verified here because Razorpay auto-
          // captures within a few seconds and fires payment.captured.
          console.log(`[razorpay/webhook] payment.authorized order=${orderId} — waiting for captured`);
          break;
        case 'payment.failed':
          await handlePaymentFailed(payment, orderId);
          break;
        default:
          console.log(`[razorpay/webhook] ignoring event=${event}`);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[razorpay/webhook] handler error event=${event}:`, err);
      // Return 200 so Razorpay doesn't retry aggressively — we've
      // already logged the error and can reconcile manually.
      return res.json({ ok: false, error: err.message });
    }
  }
);

// Money was captured. Mark the payments row as verified so idempotency
// on /qr/create + the mobile pending-order recovery flow can pick it
// up. This is the KEY handler — it closes the "UPI timeout on client
// but money actually taken" gap.
async function handlePaymentCaptured(payment, orderId) {
  if (!orderId || !payment) return;
  const res = await pool.query(
    `UPDATE payments
        SET status              = 'verified',
            razorpay_payment_id = COALESCE(razorpay_payment_id, $2),
            verified_at         = COALESCE(verified_at, NOW()),
            error_message       = NULL
      WHERE razorpay_order_id   = $1
        AND status <> 'verified'
      RETURNING id, user_id, qr_id, purpose`,
    [orderId, payment.id]
  );
  if (res.rows.length) {
    const row = res.rows[0];
    console.log(
      `[razorpay/webhook] payment.captured → payments id=${row.id} user=${row.user_id} ` +
      `qr_id=${row.qr_id || 'null (QR still needs to be created client-side)'} purpose=${row.purpose}`
    );
  } else {
    // Order not in our DB (or already verified). Could be a payment
    // we never recorded — log for reconciliation.
    console.warn(
      `[razorpay/webhook] payment.captured with no matching payments row order=${orderId} payment=${payment.id}`
    );
  }
}

async function handlePaymentFailed(payment, orderId) {
  if (!orderId || !payment) return;
  const reason = payment.error_description ||
    payment.error_reason ||
    payment.error_code ||
    'unknown';
  const res = await pool.query(
    `UPDATE payments
        SET status        = CASE WHEN status = 'verified' THEN status ELSE 'failed' END,
            error_message = COALESCE(error_message, $2)
      WHERE razorpay_order_id = $1
      RETURNING id, user_id`,
    [orderId, `webhook_${payment.error_code || 'failure'}: ${reason}`.slice(0, 500)]
  );
  if (res.rows.length) {
    console.log(
      `[razorpay/webhook] payment.failed → payments id=${res.rows[0].id} user=${res.rows[0].user_id} reason=${reason}`
    );
  }
}

export default router;
