import { config } from '../config/index.js';
import { pool } from '../db/pool.js';

// SMS provider abstraction. The user has deferred picking a provider
// (Exotel/MSG91/Twilio/Fast2SMS/etc.) — this module ships with a `console`
// provider that logs the message so the flow can be tested end-to-end
// without SMS credentials, plus stub adapter functions each named after
// the likely providers. When the choice is made, fill in the matching
// adapter body and set `SMS_PROVIDER=<name>` in the env. Nothing else
// needs to change.
//
// Contract (all providers must satisfy):
//   dispatch(toE164, message) → Promise<{ ok, messageId?, error? }>
//     - toE164:  E.164 phone e.g. "+91XXXXXXXXXX"
//     - message: plain text, ≤ 160 chars for GSM-7, ≤ 70 for Unicode
//
// Business helpers (sendLoginOtp, sendQrCreated, ...) build the message
// bodies and call dispatch(). They never throw — a bad SMS must not fail
// login, QR creation, or a webhook.

const PROVIDER = (process.env.SMS_PROVIDER || 'console').toLowerCase();
const BRAND = process.env.SMS_BRAND || 'QR4Emergency';

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
// Each adapter accepts (to, message) and returns { ok, messageId?, error? }.
// Only `console` is fully implemented. The rest are stubs that log the
// payload they WOULD have sent — flip PROVIDER once the account is live.

async function consoleProvider(to, message) {
  console.log(`[sms/console] to=${to} msg=${JSON.stringify(message)}`);
  return { ok: true, messageId: `console-${Date.now()}` };
}

async function msg91Provider(to, message) {
  // TODO: implement when MSG91 auth key + sender + DLT template ID are
  // available. MSG91 typical endpoint:
  //   POST https://api.msg91.com/api/v5/flow/
  //     headers: authkey: <MSG91_AUTH_KEY>
  //     body: { flow_id, sender, mobiles: to, variables }
  console.warn('[sms/msg91] stub — no send performed', { to, message });
  return { ok: false, error: 'msg91 adapter not implemented' };
}

async function exotelProvider(to, message) {
  // TODO: implement when Exotel SMS account is provisioned. Endpoint:
  //   POST https://<sid>:<token>@api.exotel.com/v1/Accounts/<sid>/Sms/send
  //     form: From=<VirtualNumber>, To=<E.164>, Body=<message>
  //     DLT: EntityId, TemplateId as required in India.
  console.warn('[sms/exotel] stub — no send performed', { to, message });
  return { ok: false, error: 'exotel adapter not implemented' };
}

async function twilioProvider(to, message) {
  // TODO: implement when a Twilio international SMS account is set up.
  console.warn('[sms/twilio] stub — no send performed', { to, message });
  return { ok: false, error: 'twilio adapter not implemented' };
}

async function fast2smsProvider(to, message) {
  // TODO: implement when Fast2SMS account is provisioned.
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
async function dispatch(rawTo, message) {
  const to = toE164(rawTo);
  if (!to) {
    console.warn('[sms] refusing to send — bad recipient', rawTo);
    return { ok: false, error: 'invalid_recipient' };
  }
  const fn = PROVIDERS[PROVIDER] || consoleProvider;
  try {
    return await fn(to, message);
  } catch (err) {
    console.error(`[sms/${PROVIDER}] send failed:`, err.message);
    return { ok: false, error: err.message };
  }
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
// Copy is hand-tuned to fit 160 chars where possible so nothing splits
// into two billed segments.

export async function sendLoginOtp(mobile, otp) {
  const msg = `${BRAND}: Your login code is ${otp}. Do not share this with anyone. Valid for 5 minutes.`;
  return dispatch(mobile, msg);
}

export async function sendQrCreated({ mobile, vehicle_number, owner_number }) {
  const msg =
    `${BRAND}: Your QR for vehicle ${vehicle_number} (owner ${owner_number}) is generated. ` +
    `Sticker will be delivered to your address in 3-5 working days.`;
  return dispatch(mobile, msg);
}

export async function sendQrScannedOwnerTap(qrId) {
  const owner = await getOwnerForQr(qrId);
  if (!owner || !owner.mobile) return { ok: false, error: 'no_owner_mobile' };
  const msg =
    `${BRAND}: Someone scanned your vehicle ${owner.vehicle || 'QR'} and ` +
    `tapped Call Owner. Check the app for details.`;
  return dispatch(owner.mobile, msg);
}

export async function sendQrScannedFamilyTap(qrId) {
  const owner = await getOwnerForQr(qrId);
  if (!owner || !owner.mobile) return { ok: false, error: 'no_owner_mobile' };
  const msg =
    `${BRAND}: Someone scanned your vehicle ${owner.vehicle || 'QR'} — ` +
    `they may need help from you. Check the app for details.`;
  return dispatch(owner.mobile, msg);
}

export async function sendExpiryCountdown({ mobile, vehicle_number, days_left, app_link, web_link }) {
  const links = [app_link, web_link].filter(Boolean).join(' or ');
  const linkFrag = links ? ` Renew via ${links}.` : '';
  const msg =
    `${BRAND}: Your QR for ${vehicle_number} expires in ${days_left} day` +
    `${days_left === 1 ? '' : 's'}.${linkFrag}`;
  return dispatch(mobile, msg);
}

// Named export for anywhere that wants an ad-hoc send (admin panel, ops).
export async function sendSms(to, message) {
  return dispatch(to, message);
}

export function currentProvider() {
  return PROVIDER;
}
