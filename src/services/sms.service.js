import { config } from '../config/index.js';
import { pool } from '../db/pool.js';

// SMS provider abstraction. Ships with a `console` provider for local
// dev (logs the message) and a real `exotel` provider used in prod.
// Additional providers (msg91, twilio, fast2sms) remain as stubs so
// SMS_PROVIDER can be switched by env var without a code change.
//
// Contract (all providers must satisfy):
//   dispatch(toE164, message, { dltTemplateId }) →
//       Promise<{ ok, messageId?, error? }>
//     - toE164:        E.164 phone e.g. "+91XXXXXXXXXX"
//     - message:       final text, already interpolated. Must match a
//                      DLT-approved template body character-for-character
//                      (excluding placeholder substitution).
//     - dltTemplateId: numeric string DLT template id — MUST be the same
//                      template whose text `message` was built from.
//
// Business helpers (sendLoginOtp, sendQrCreated, ...) build the message
// bodies using the exact DLT-approved template text below and call
// dispatch() with the matching template id. They never throw — a bad SMS
// must not fail login, QR creation, or a webhook.

const PROVIDER = (process.env.SMS_PROVIDER || 'console').toLowerCase();

// ─── DLT-approved templates ─────────────────────────────────────────────
//
// These strings are registered with Airtel DLT under C.P. Network Pvt Ltd.
// The SMS body sent MUST match the template text with only the {#var#} /
// {#alp#} / {#num#} slots substituted — any other change (extra space,
// different casing, reordered variables) causes Airtel to reject the send.
//
// If you edit copy here, re-register the template on the DLT portal FIRST
// and update the id to the new registration.
//
// `disabled: true` short-circuits the corresponding business helper so
// no request is sent to Exotel. Used for templates that Exotel accepts
// (200 + Sid) but Airtel silently drops (status stuck on
// PENDING_ON_OPERATOR). Flip back to `false` once the DLT / operator
// path is fixed.
export const TEMPLATES = {
  LOGIN_OTP: {
    id: '1007922664459878090',
    disabled: false,
    // {#var#} = OTP
    build: (otp) =>
      `Your OTP for login to QR4Emergency is ${otp}. It is valid for 10 minutes. Do not share this OTP with anyone. C.P. Network Pvt Ltd`,
  },
  EXPIRY: {
    id: '1007066007108026811',
    // Airtel returns PENDING_ON_OPERATOR indefinitely for this template.
    // Under investigation with Exotel support — keep disabled so the
    // scheduler doesn't burn billed SMS on undelivered messages.
    disabled: true,
    // {#var#} = days remaining, {#var#} = expiry date (DD-MM-YYYY)
    build: (daysLeft, expiryDate) =>
      `Your QR4Emergency QR Code will expire in ${daysLeft} days on ${expiryDate}. Please renew now to keep your emergency profile active. C.P. Network Pvt Ltd`,
  },
  QR_SUCCESS: {
    id: '1007379251439938740',
    disabled: false,
    // {#var#} = owner name
    build: (ownerName) =>
      `Dear ${ownerName}, your QR4Emergency QR Code has been created successfully. Please log in to the app to download and place it on your vehicle. C.P. Network Pvt Ltd`,
  },
  QR_SCAN_ALERT: {
    id: '1077103480001223049',
    disabled: false,
    // {#alp#} = vehicle number
    build: (vehicleNumber) =>
      `QR4Emergency Alert: Someone scanned the Emergency QR of vehicle ${vehicleNumber}. The owner may need your help. Please contact them immediately.`,
  },
  QR_GENERATED: {
    id: '1077180900001249109',
    disabled: false,
    // {#alp#} = vehicle number, {#num#} = owner phone
    build: (vehicleNumber, ownerNumber) =>
      `QR4Emergency: Your Emergency QR for vehicle ${vehicleNumber} has been generated. Owner contact: ${ownerNumber}. It will be delivered to your doorstep in 3-5 working days.`,
  },
};

// Normalize any Indian phone number to E.164 (+91XXXXXXXXXX). Passes E.164
// input through unchanged. Providers reject bare 10-digit numbers.
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\D/g, '');
  if (s.length === 10) return `+91${s}`;
  if (s.length === 12 && s.startsWith('91')) return `+${s}`;
  if (s.length === 13 && s.startsWith('91')) return `+${s.slice(0, 12)}`;
  if (String(raw).startsWith('+')) return String(raw).trim();
  return null;
}

// ─── Provider adapters ──────────────────────────────────────────────────

async function consoleProvider(to, message, { dltTemplateId } = {}) {
  console.log(
    `[sms/console] to=${to} tid=${dltTemplateId || '-'} msg=${JSON.stringify(message)}`
  );
  return { ok: true, messageId: `console-${Date.now()}` };
}

// Exotel v1 SMS API. Uses HTTP Basic (APIKey:APIToken) against a
// region-specific subdomain. All DLT-required parameters are passed on
// every send — Airtel/Jio/VI will silently drop SMS missing DltEntityId
// or a mismatched DltTemplateId, so we fail closed if any credential is
// missing rather than firing a paid-but-undelivered message.
// Print a short fingerprint of each credential on first call so we can
// diff Render vs local without ever logging the full secret. Format:
// `<first-4>…<last-4>[<length>]` — enough to spot a swap, extra char,
// or invisible unicode without exposing anything reusable.
let _fingerprintLogged = false;
function logCredFingerprint() {
  if (_fingerprintLogged) return;
  _fingerprintLogged = true;
  const fp = (v) => {
    const s = String(v || '');
    if (!s) return '<empty>';
    if (s.length <= 8) return `${s.length} chars`;
    return `${s.slice(0, 4)}…${s.slice(-4)}[${s.length}]`;
  };
  const { sid, apiKey, apiToken, sender, entityId, subdomain } = config.exotel;
  console.log(
    `[sms/exotel] cred fingerprint ` +
      `sid=${fp(sid)} key=${fp(apiKey)} token=${fp(apiToken)} ` +
      `entity=${fp(entityId)} sender=${sender} subdomain=${subdomain}`
  );
}

async function exotelProvider(to, message, { dltTemplateId } = {}) {
  const { sid, apiKey, apiToken, sender, entityId, subdomain } = config.exotel;
  logCredFingerprint();
  const missing = [];
  if (!sid) missing.push('EXOTEL_SID');
  if (!apiKey) missing.push('EXOTEL_API_KEY');
  if (!apiToken) missing.push('EXOTEL_API_TOKEN');
  if (!sender) missing.push('EXOTEL_SENDER');
  if (!entityId) missing.push('EXOTEL_DLT_ENTITY_ID');
  if (missing.length) {
    console.warn(
      `[sms/exotel] missing env: ${missing.join(', ')} — refusing to send`
    );
    return { ok: false, error: `exotel_missing_env:${missing.join(',')}` };
  }
  if (!dltTemplateId) {
    console.warn('[sms/exotel] refusing to send — no dltTemplateId supplied');
    return { ok: false, error: 'exotel_missing_dlt_template' };
  }

  const url = `https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Sms/send.json`;
  const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
  const form = new URLSearchParams();
  form.set('From', sender);
  form.set('To', to);
  form.set('Body', message);
  // Exotel maps these to the DLT compliance fields. Naming varies by
  // Exotel account age — the modern parameters are DltEntityId /
  // DltTemplateId, older accounts may accept EntityId / TemplateId; we
  // send both to be safe.
  form.set('DltEntityId', entityId);
  form.set('DltTemplateId', dltTemplateId);
  form.set('EntityId', entityId);
  form.set('TemplateId', dltTemplateId);
  form.set('SmsType', 'transactional');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    // Exotel returns JSON on both success and failure; parse defensively.
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const restException = payload?.RestException?.Message || payload?.raw || `HTTP ${res.status}`;
      console.warn(
        `[sms/exotel] send failed to=${to} status=${res.status} err=${restException}`
      );
      return { ok: false, error: String(restException).slice(0, 200) };
    }
    // On success Exotel puts the SMS SID in SMSMessage.Sid or Call.Sid.
    const messageId =
      payload?.SMSMessage?.Sid ||
      payload?.Call?.Sid ||
      payload?.Sid ||
      null;
    console.log(
      `[sms/exotel] sent to=${to} tid=${dltTemplateId} sid=${messageId || '-'}`
    );
    return { ok: true, messageId };
  } catch (err) {
    console.error(`[sms/exotel] fetch threw:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function msg91Provider(to, message) {
  console.warn('[sms/msg91] stub — no send performed', { to, message });
  return { ok: false, error: 'msg91 adapter not implemented' };
}

async function twilioProvider(to, message) {
  console.warn('[sms/twilio] stub — no send performed', { to, message });
  return { ok: false, error: 'twilio adapter not implemented' };
}

async function fast2smsProvider(to, message) {
  console.warn('[sms/fast2sms] stub — no send performed', { to, message });
  return { ok: false, error: 'fast2sms adapter not implemented' };
}

const PROVIDERS = {
  console: consoleProvider,
  msg91: msg91Provider,
  exotel: exotelProvider,
  twilio: twilioProvider,
  fast2sms: fast2smsProvider,
};

// Core dispatcher. Never throws.
async function dispatch(rawTo, message, options = {}) {
  const to = toE164(rawTo);
  if (!to) {
    console.warn('[sms] refusing to send — bad recipient', rawTo);
    return { ok: false, error: 'invalid_recipient' };
  }
  const fn = PROVIDERS[PROVIDER] || consoleProvider;
  try {
    return await fn(to, message, options);
  } catch (err) {
    console.error(`[sms/${PROVIDER}] send failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Every helper flows through this so the disable flag is honoured
// uniformly: no request is sent, no SMS billed, one log line for
// observability.
async function dispatchTemplate(template, rawTo, ...buildArgs) {
  if (template.disabled) {
    console.warn(
      `[sms] skipped disabled template tid=${template.id} to=${rawTo}`
    );
    return { ok: false, error: 'template_disabled' };
  }
  return dispatch(rawTo, template.build(...buildArgs), {
    dltTemplateId: template.id,
  });
}

// Fetch the owner-mobile for a QR — used by all "someone scanned/called
// your QR" helpers. Returns { mobile, vehicle_number } or null.
async function getOwnerForQr(qrId) {
  try {
    const r = await pool.query(
      `SELECT q.mobile, q.vehicle_number, u.mobile AS user_mobile
         FROM qrdata q
         LEFT JOIN users u ON u.id = q.user_id
        WHERE q.id = $1`,
      [qrId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    // Prefer the QR-registered owner mobile (that's the one the sticker
    // is meant to reach). Fall back to the user's login mobile if the QR
    // row has none.
    return {
      mobile: row.mobile || row.user_mobile || null,
      vehicle: row.vehicle_number || '',
    };
  } catch (err) {
    console.error('[sms] getOwnerForQr failed:', err.message);
    return null;
  }
}

// ─── Business helpers ───────────────────────────────────────────────────
// Every helper builds its message via TEMPLATES.<X>.build(...) and
// dispatches with the matching template id, so the body sent over the
// wire is guaranteed to match the DLT registration.

// Login OTP.
export async function sendLoginOtp(mobile, otp) {
  return dispatchTemplate(TEMPLATES.LOGIN_OTP, mobile, otp);
}

// QR generated — confirmation SMS with vehicle number + owner contact +
// delivery timeline. Kept the legacy `sendQrCreated` export name so
// existing callers (qr.service.js) don't need to change.
export async function sendQrCreated({ mobile, vehicle_number, owner_number }) {
  return dispatchTemplate(
    TEMPLATES.QR_GENERATED,
    mobile,
    vehicle_number,
    owner_number
  );
}

// QR activated successfully — sent to the app user with a login prompt
// so they can download the sticker. Requires the owner's display name.
export async function sendQrSuccess({ mobile, owner_name }) {
  return dispatchTemplate(
    TEMPLATES.QR_SUCCESS,
    mobile,
    owner_name || 'Customer'
  );
}

// Alert SMS — sent when a bystander taps a contact on the alert page.
// DLT registers one template for both owner-tap and family-tap since the
// text is identical; the two helper names remain for caller clarity.
// Currently disabled at the template level (see TEMPLATES.QR_SCAN_ALERT).
async function sendScanAlert(qrId) {
  const owner = await getOwnerForQr(qrId);
  if (!owner || !owner.mobile) return { ok: false, error: 'no_owner_mobile' };
  return dispatchTemplate(
    TEMPLATES.QR_SCAN_ALERT,
    owner.mobile,
    owner.vehicle || 'your vehicle'
  );
}
export const sendQrScannedOwnerTap = sendScanAlert;
export const sendQrScannedFamilyTap = sendScanAlert;

// Daily expiry countdown. Template needs {days_left} + {expiry_date};
// caller passes days_left and we derive the date so callers don't have
// to duplicate the formatting. Currently disabled at the template
// level (see TEMPLATES.EXPIRY).
export async function sendExpiryCountdown({ mobile, days_left, expiry_date }) {
  // Format as DD-MM-YYYY (Indian convention). If caller supplied a Date
  // or ISO string, use it; otherwise derive from today + days_left.
  const d = expiry_date
    ? new Date(expiry_date)
    : new Date(Date.now() + Math.max(0, days_left) * 86_400_000);
  const dateStr = [
    String(d.getDate()).padStart(2, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    d.getFullYear(),
  ].join('-');
  return dispatchTemplate(TEMPLATES.EXPIRY, mobile, days_left, dateStr);
}

// Named export for anywhere that wants an ad-hoc send. Callers MUST
// supply a dltTemplateId whose registered body matches `message` — bare
// unregistered sends will be rejected by DLT.
export async function sendSms(to, message, { dltTemplateId } = {}) {
  return dispatch(to, message, { dltTemplateId });
}

export function currentProvider() {
  return PROVIDER;
}
