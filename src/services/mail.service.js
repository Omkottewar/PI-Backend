import nodemailer from 'nodemailer';
import { config } from '../config/index.js';

// Lazy-built transporter so we don't crash the boot if SMTP creds are
// missing in dev. On first send we check config; if unset, we log and
// no-op — the QR creation transaction has already committed, we don't
// want a missing SMTP secret to look like a failure to the caller.
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const { host, port, secure, user, pass } = config.smtp;
  if (!host || !user || !pass) return null;
  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return _transporter;
}

function fmtCurrency(amount, currency) {
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${amount.toLocaleString('en-IN')}`;
}

function invoiceNumber(qr) {
  // Human-friendly, monotonically increasing, per-row. `qr.id` is the
  // internal PK; padding to 6 digits keeps the invoice number stable
  // width for early customers.
  return `INV-${String(qr.id).padStart(6, '0')}`;
}

function buildInvoiceHtml(qr, family) {
  const inv = config.invoice;
  // Line-item breakdown so the invoice shows Platform + Shipping
  // distinctly. Falls back to the legacy single-amount view if the
  // pricing config is missing for any reason (e.g., older deploy).
  const platformPaise = config.pricing?.platformFeePaise ?? 0;
  const shippingPaise = config.pricing?.shippingFeePaise ?? 0;
  const totalPaise = platformPaise + shippingPaise;
  const platformText = fmtCurrency(Math.round(platformPaise / 100), inv.currency);
  const shippingText = fmtCurrency(Math.round(shippingPaise / 100), inv.currency);
  const totalText = totalPaise > 0
    ? fmtCurrency(Math.round(totalPaise / 100), inv.currency)
    : fmtCurrency(inv.amount, inv.currency);
  const activatedOn = new Date(qr.date_of_activation || qr.created_at || Date.now());
  const activationText = activatedOn.toLocaleDateString('en-IN', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const familyRows = (family || [])
    .map(
      (f) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(f.name || '')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;">${escapeHtml(f.relation || '')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(f.phone || '')}</td>
        </tr>`
    )
    .join('');
  const alertUrl = `${config.publicAppUrl}/alert/${qr.unique_id}?digits=${qr.digits}`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
    <div style="max-width:620px;margin:0 auto;padding:32px 20px;">
      <div style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.05);">
        <div style="background:linear-gradient(135deg,#FF7A00 0%,#DC2626 100%);padding:24px 28px;color:#fff;">
          <div style="font-size:12px;letter-spacing:2.4px;font-weight:800;opacity:0.85;">QR 4 EMERGENCY · BE NAYAK</div>
          <div style="font-size:24px;font-weight:800;margin-top:6px;">Invoice ${escapeHtml(invoiceNumber(qr))}</div>
        </div>
        <div style="padding:24px 28px;">
          <p style="margin:0 0 12px;font-size:15px;">Hi ${escapeHtml(qr.name || 'there')},</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#444;">
            Thanks for activating your QR 4 Emergency sticker. Your vehicle is
            now covered — bystanders who scan your QR will bridge through to
            your emergency contacts via a masked call. Here's your invoice.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0 24px;">
            <tr>
              <td style="padding:8px 0;color:#666;">Vehicle</td>
              <td style="padding:8px 0;text-align:right;font-weight:700;font-family:monospace;">${escapeHtml(qr.vehicle_number || '—')}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;">Extension number</td>
              <td style="padding:8px 0;text-align:right;font-weight:700;font-family:monospace;">${escapeHtml(String(qr.digits || ''))}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;">Activated on</td>
              <td style="padding:8px 0;text-align:right;">${escapeHtml(activationText)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;">Plan</td>
              <td style="padding:8px 0;text-align:right;">QR 4 Emergency (One-time purchase, no renewal)</td>
            </tr>
            ${totalPaise > 0 ? `
            <tr>
              <td style="padding:8px 0;color:#666;">Platform fee</td>
              <td style="padding:8px 0;text-align:right;">${escapeHtml(platformText)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;">Shipping</td>
              <td style="padding:8px 0;text-align:right;">${escapeHtml(shippingText)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#666;border-top:1px solid #eee;">Total paid</td>
              <td style="padding:8px 0;text-align:right;font-weight:800;font-size:16px;border-top:1px solid #eee;">${escapeHtml(totalText)}</td>
            </tr>
            ` : `
            <tr>
              <td style="padding:8px 0;color:#666;">Amount</td>
              <td style="padding:8px 0;text-align:right;font-weight:800;font-size:16px;">${escapeHtml(totalText)}</td>
            </tr>
            `}
          </table>

          ${familyRows
            ? `<div style="font-size:11px;font-weight:800;letter-spacing:1.4px;color:#FF7A00;margin:4px 0 8px;">EMERGENCY CONTACTS</div>
               <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fafafa;border-radius:8px;overflow:hidden;">
                 ${familyRows}
               </table>`
            : ''}

          <div style="margin-top:24px;padding:16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;font-size:13px;line-height:1.55;color:#7c2d12;">
            Your alert page is live at
            <a href="${escapeHtml(alertUrl)}" style="color:#c2410c;font-weight:700;text-decoration:none;">${escapeHtml(alertUrl)}</a>
          </div>

          <p style="margin:24px 0 4px;font-size:12px;color:#666;line-height:1.55;">
            ${escapeHtml(config.invoice.company)} · ${escapeHtml(config.invoice.companyAddress)}<br/>
            ${escapeHtml(config.invoice.companyEmail)} · ${escapeHtml(config.invoice.companyPhone)}
          </p>
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#999;margin:16px 0 0;">
        You're receiving this because you activated a QR 4 Emergency sticker.
      </p>
    </div>
  </body>
</html>`;
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Fire-and-forget invoice email. Never throws — a broken SMTP config
// must not roll back a successful QR activation.
export async function sendInvoiceEmail(qr, family = []) {
  try {
    const to = (qr && qr.email ? String(qr.email).trim() : '') || '';
    if (!to) {
      console.log('[mail/invoice] skipped: no recipient email on QR', qr?.id);
      return { skipped: true, reason: 'no_recipient' };
    }
    const transporter = getTransporter();
    if (!transporter) {
      console.log('[mail/invoice] skipped: SMTP not configured');
      return { skipped: true, reason: 'not_configured' };
    }
    const from = config.smtp.from || config.smtp.user;
    const subject = `Your QR 4 Emergency invoice · ${invoiceNumber(qr)}`;
    const html = buildInvoiceHtml(qr, family);
    const info = await transporter.sendMail({
      from: `"QR 4 Emergency" <${from}>`,
      to,
      subject,
      html,
    });
    console.log('[mail/invoice] sent', { to, messageId: info.messageId, qrId: qr.id });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    // Log and swallow — the caller's transaction is already committed.
    console.error('[mail/invoice] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}
