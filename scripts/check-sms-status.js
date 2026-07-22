// Pull delivery status for a specific SMS from Exotel. The Sid comes
// from the "Result: { messageId: ... }" line of test-sms.js. Exotel's
// response includes a `DetailedStatus` field that tells us exactly
// what happened at the operator (Airtel/Jio/VI) — e.g. DELIVERED,
// DND_FAIL, TEMPLATE_MISMATCH, INVALID_ENTITY_ID.
//
// Usage:
//   node scripts/check-sms-status.js <SmsSid>

import 'dotenv/config';
import { config } from '../src/config/index.js';

const [, , sid] = process.argv;
if (!sid) {
  console.error('Usage: node scripts/check-sms-status.js <SmsSid>');
  process.exit(1);
}

async function main() {
  const { sid: accountSid, apiKey, apiToken, subdomain } = config.exotel;
  if (!accountSid || !apiKey || !apiToken) {
    console.error('Exotel env not configured — set EXOTEL_SID/API_KEY/API_TOKEN in .env');
    process.exit(1);
  }
  const url = `https://${subdomain}/v1/Accounts/${accountSid}/SMS/Messages/${sid}.json`;
  const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, data);
    process.exit(1);
  }
  const m = data.SMSMessage || data;
  // Highlight the fields that actually matter for diagnosing why a
  // message wasn't received.
  console.log(JSON.stringify(m, null, 2));
  console.log('---');
  console.log(`Status:          ${m.Status || '-'}`);
  console.log(`DetailedStatus:  ${m.DetailedStatus || '-'}`);
  console.log(`DateSent:        ${m.DateSent || '(not sent yet)'}`);
  console.log(`Price:           ${m.Price || '(not billed)'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
