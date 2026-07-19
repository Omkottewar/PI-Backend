import { pool } from '../db/pool.js';

// Self-heal guard for a fresh pod that hasn't run migration 020. Same
// pattern as login_otp / sms_expiry_log so this table can be added
// without a deployment-time DB migration step.
let _ensured = false;
async function ensurePaymentsTable() {
  if (_ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id                    SERIAL PRIMARY KEY,
      user_id               INT REFERENCES users(id) ON DELETE SET NULL,
      qr_id                 INT REFERENCES qrdata(id) ON DELETE SET NULL,
      purpose               VARCHAR(20) NOT NULL,
      razorpay_order_id     VARCHAR(64) NOT NULL,
      razorpay_payment_id   VARCHAR(64),
      razorpay_signature    TEXT,
      amount_paise          INT NOT NULL,
      intended_amount_paise INT NOT NULL,
      currency              VARCHAR(8) NOT NULL DEFAULT 'INR',
      status                VARCHAR(20) NOT NULL DEFAULT 'created',
      error_message         TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at           TIMESTAMPTZ,
      UNIQUE (razorpay_order_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_qr_idx   ON payments(qr_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_created_idx ON payments(created_at DESC);`);
  _ensured = true;
}

// Called immediately after createOrder() succeeds. `qr_id` is nullable
// here because the initial-QR flow doesn't have a qrdata row yet — it
// gets linked later via markPaymentVerified(). Idempotent on
// razorpay_order_id (ON CONFLICT DO NOTHING) so a rare retry doesn't
// blow up.
export async function recordOrderCreated({
  userId,
  qrId = null,
  purpose,               // 'qr_create' or 'qr_renew'
  razorpayOrderId,
  amountPaise,
  intendedAmountPaise,
  currency = 'INR',
}) {
  try {
    await ensurePaymentsTable();
    await pool.query(
      `INSERT INTO payments
         (user_id, qr_id, purpose, razorpay_order_id,
          amount_paise, intended_amount_paise, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'created')
       ON CONFLICT (razorpay_order_id) DO NOTHING`,
      [userId, qrId, purpose, razorpayOrderId,
       amountPaise, intendedAmountPaise, currency]
    );
  } catch (err) {
    // NEVER fail the caller because of an audit-table write — the
    // Razorpay order is already live at this point. But log with a
    // `[CRITICAL]` marker so Render's log-alerts pick this up.
    console.error(
      '[CRITICAL][payments] recordOrderCreated failed — order lives on Razorpay ' +
      'but has no local audit row. Manual reconciliation needed. ' +
      `order_id=${razorpayOrderId} user=${userId} amount=${amountPaise} err=${err.message}`
    );
  }
}

// Called after signature verification succeeds. Fills in the missing
// fields (payment id, signature, verified_at) and links the qrdata row
// if it was created after the order (initial-QR flow).
export async function markPaymentVerified({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  qrId = null,
}) {
  try {
    await ensurePaymentsTable();
    await pool.query(
      `UPDATE payments
          SET status              = 'verified',
              razorpay_payment_id = $2,
              razorpay_signature  = $3,
              qr_id               = COALESCE(qr_id, $4),
              verified_at         = NOW(),
              error_message       = NULL
        WHERE razorpay_order_id   = $1`,
      [razorpayOrderId, razorpayPaymentId, razorpaySignature, qrId]
    );
  } catch (err) {
    // CRITICAL: customer was charged and QR was created but our audit
    // trail didn't catch up. Payment row is stuck in 'created' state
    // even though it succeeded — reconciliation cron / manual admin
    // needs to fix this row. Loud marker so it doesn't get lost.
    console.error(
      '[CRITICAL][payments] markPaymentVerified failed — payment succeeded ' +
      'but audit row is stale. Reconciliation needed. ' +
      `order_id=${razorpayOrderId} payment_id=${razorpayPaymentId} qr_id=${qrId} err=${err.message}`
    );
  }
}

// Called when signature verification fails or Razorpay reports a
// checkout failure. Keeps the row for later reconciliation instead of
// deleting it.
export async function markPaymentFailed({
  razorpayOrderId,
  errorMessage,
}) {
  try {
    await ensurePaymentsTable();
    await pool.query(
      `UPDATE payments
          SET status        = 'failed',
              error_message = $2
        WHERE razorpay_order_id = $1
          AND status <> 'verified'`,
      [razorpayOrderId, errorMessage]
    );
  } catch (err) {
    console.error(
      `[payments] markPaymentFailed failed order_id=${razorpayOrderId} err=${err.message}`
    );
  }
}

// Records a client-side Razorpay event (success/failure/dismiss/wallet)
// so we get server-side visibility into failures that never make it to
// /qr/create. When the SDK fires an error on the user's device (declined
// card, network drop mid-checkout, modal dismissed) the backend never
// hears about it unless the client reports — this is that report.
//
// We ALSO mirror the outcome onto the payments row so the admin panel's
// orphaned-payments view shows client-observed failures next to
// server-observed ones.
export async function trackClientEvent({
  userId,
  razorpayOrderId,
  event,          // 'success' | 'failure' | 'dismiss' | 'external_wallet'
  code,           // Razorpay error code, if any
  description,    // Razorpay description or reason
  source,         // 'qr_create' | 'qr_renew' — helps disambiguate
  raw,            // free-form JSON blob from the SDK
}) {
  // "Money taken but QR not created" is the highest-severity payment
  // failure we can see — log it with a [CRITICAL] marker so it's easy
  // to alert on and easy to spot when triaging incidents. Handler
  // crashes go in this bucket too: they mean a Razorpay event fired
  // but our own code blew up before completing the flow.
  const criticalEvents = new Set([
    'qr_creation_failed_after_payment',
    'qr_creation_stuck',
    'success_handler_crashed',
    'error_handler_crashed',
    'checkout_open_failed',
  ]);
  const isCritical = criticalEvents.has(event);
  const tag = isCritical
    ? '[razorpay/client-fail] [CRITICAL]'
    : event === 'success'
      ? '[razorpay/client-event]'
      : '[razorpay/client-fail]';
  const level = event === 'success' ? 'log' : 'error';
  // One structured line — searchable with `[razorpay/client-` in Render
  // logs, or `[CRITICAL]` for the payment-taken-but-QR-not-created case.
  console[level](
    `${tag} user=${userId} order=${razorpayOrderId || '(none)'} event=${event} ` +
    `code=${code || '-'} desc=${(description || '').replace(/\s+/g, ' ')} ` +
    `source=${source || '-'} raw=${JSON.stringify(raw || {}).slice(0, 500)}`
  );
  // Best-effort persistence so the audit trail carries the failure
  // reason even if server-side logs get rotated out. The verified-status
  // guard means we never overwrite a webhook-confirmed payment; we only
  // add an error_message note.
  const persistFailures = new Set([
    'failure',
    'qr_creation_failed_after_payment',
    'qr_creation_stuck',
    'success_handler_crashed',
    'error_handler_crashed',
    'checkout_open_failed',
  ]);
  if (persistFailures.has(event) && razorpayOrderId) {
    try {
      await ensurePaymentsTable();
      await pool.query(
        `UPDATE payments
            SET status        = CASE WHEN status = 'verified' THEN status ELSE 'failed' END,
                error_message = COALESCE(error_message, $2)
          WHERE razorpay_order_id = $1`,
        [razorpayOrderId, `client_${event}_${code || 'unknown'}: ${description || ''}`.trim().slice(0, 500)]
      );
    } catch (err) {
      console.error('[payments] trackClientEvent update failed:', err.message);
    }
  }
}

// Reconciliation helper — a payment is "orphaned" when it's been sitting
// in `created` status too long (>10 min). Either Razorpay never charged
// it (user closed the modal), or Razorpay charged but our /qr/create
// path failed AFTER signature verify and before markPaymentVerified.
// Admin panel uses this list to spot payments that need manual refund.
export async function listOrphanedPayments({ olderThanMinutes = 10, limit = 200 } = {}) {
  try {
    await ensurePaymentsTable();
    const r = await pool.query(
      `SELECT p.id, p.user_id, p.qr_id, p.purpose,
              p.razorpay_order_id, p.razorpay_payment_id,
              p.amount_paise, p.intended_amount_paise,
              p.status, p.error_message, p.created_at, p.verified_at,
              u.mobile AS user_mobile,
              EXTRACT(EPOCH FROM (NOW() - p.created_at))::int AS age_seconds
         FROM payments p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.status = 'created'
          AND p.created_at < NOW() - ($1 || ' minutes')::INTERVAL
        ORDER BY p.created_at DESC
        LIMIT $2`,
      [String(olderThanMinutes), limit]
    );
    return r.rows;
  } catch (err) {
    console.error('[payments] listOrphanedPayments failed:', err.message);
    return [];
  }
}

// Cheap status probe used by mobile's pending-order recovery — after
// the app is killed mid-checkout, the client asks "does this order
// still exist and what's its state?" so it can either resume or drop.
export async function getPaymentStatus(razorpayOrderId, userId) {
  try {
    await ensurePaymentsTable();
    const r = await pool.query(
      `SELECT status, qr_id, razorpay_payment_id, amount_paise,
              intended_amount_paise, error_message, verified_at
         FROM payments
        WHERE razorpay_order_id = $1 AND user_id = $2`,
      [razorpayOrderId, userId]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error('[payments] getPaymentStatus failed:', err.message);
    return null;
  }
}
