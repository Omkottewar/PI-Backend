// Ad-hoc SMS tester. Fires one of the DLT-approved templates through
// the same sms.service.js pipeline the real app uses, so if this works
// the /auth/login and QR-created SMS paths work too.
//
// Usage:
//   node scripts/test-sms.js <mobile> [template]
//
//   mobile   — E.164 or bare 10-digit Indian number (auto +91 prefixed)
//   template — one of: otp | generated | success | scan | expiry
//              defaults to `otp`.
//
// Reads .env from backend/ so credentials are picked up automatically.

import 'dotenv/config';
import { randomInt } from 'crypto';
import {
  sendLoginOtp,
  sendQrCreated,
  sendQrSuccess,
  sendExpiryCountdown,
  sendSms,
  TEMPLATES,
  currentProvider,
} from '../src/services/sms.service.js';

const [, , mobileArg, templateArg = 'otp'] = process.argv;

if (!mobileArg) {
  console.error('Usage: node scripts/test-sms.js <mobile> [otp|generated|success|scan|expiry]');
  process.exit(1);
}

async function main() {
  console.log(`Provider: ${currentProvider()}`);
  console.log(`Target: ${mobileArg}`);
  console.log(`Template: ${templateArg}`);
  console.log('---');

  let result;
  switch (templateArg) {
    case 'otp': {
      // Match the real auth flow — random 4-digit code, zero-padded so
      // low numbers still look like OTPs ("0042" not "42").
      const otp = String(randomInt(0, 10000)).padStart(4, '0');
      console.log(`Random OTP: ${otp}`);
      result = await sendLoginOtp(mobileArg, otp);
      break;
    }
    case 'generated':
      result = await sendQrCreated({
        mobile: mobileArg,
        vehicle_number: 'MH12AE0786',
        owner_number: '+919876543210',
      });
      break;
    case 'success':
      result = await sendQrSuccess({
        mobile: mobileArg,
        owner_name: 'Test User',
      });
      break;
    case 'scan':
      // sendQrScanned* helpers take a qrId and look up the owner from
      // the DB — inconvenient for an ad-hoc test. Build the message
      // directly, but honour the same `disabled` flag production paths
      // use so this script's behaviour matches what the app will do.
      {
        const t = TEMPLATES.QR_SCAN_ALERT;
        if (t.disabled) {
          console.log(`[sms] skipped disabled template tid=${t.id} to=${mobileArg}`);
          result = { ok: false, error: 'template_disabled' };
        } else {
          result = await sendSms(mobileArg, t.build('MH12AE0786'), {
            dltTemplateId: t.id,
          });
        }
      }
      break;
    case 'expiry':
      result = await sendExpiryCountdown({
        mobile: mobileArg,
        days_left: 3,
      });
      break;
    default:
      console.error(`Unknown template "${templateArg}". Use: otp | generated | success | scan | expiry`);
      process.exit(1);
  }

  console.log('Result:', result);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
