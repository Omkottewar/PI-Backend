import dotenv from 'dotenv';

dotenv.config();

console.log("DB URL:", process.env.DATABASE_URL);
export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  // Secret configured in Razorpay Dashboard → Settings → Webhooks. Used
  // to verify the X-Razorpay-Signature header on incoming webhook POSTs
  // so a third party can't forge payment.captured events. If unset, the
  // webhook endpoint accepts nothing — safer default than accepting
  // unsigned events.
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  // Temporary static OTP accepted alongside real per-mobile OTPs so the
  // team can log in while an SMS provider is still being picked. When
  // this is set, every user can log in with either the real OTP that
  // would have been SMS'd OR this fixed code. Unset it (or set to '')
  // the moment a live SMS provider goes into SMS_PROVIDER — otherwise
  // any attacker who guesses this code owns every account.
  devStaticOtp: (process.env.DEV_STATIC_OTP || '').trim(),
  // SMTP config for transactional email (invoice on QR activation). All
  // values are optional at boot — if any are missing the mail service
  // silently no-ops. Gmail SMTP: host smtp.gmail.com, port 465, secure=true,
  // user=<inbox>, pass=<16-char app password> from Google account security.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_SECURE || 'true') !== 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },
  invoice: {
    // Displayed on the invoice email — kept in one place so pricing changes
    // don't need a hunt through templates.
    amount: parseInt(process.env.INVOICE_AMOUNT || '299', 10),
    currency: process.env.INVOICE_CURRENCY || 'INR',
    company: process.env.INVOICE_COMPANY || 'CP Network Private Limited',
    companyAddress:
      process.env.INVOICE_COMPANY_ADDRESS ||
      'Bhagwan Nagar, Nagpur, Maharashtra 440027, India',
    companyEmail: process.env.INVOICE_COMPANY_EMAIL || 'support@cpnetwork.in',
    companyPhone: process.env.INVOICE_COMPANY_PHONE || '+91-9960049208',
  },
  // Renewal pricing. Kept separate from the first-year price (in
  // DEFAULT_AMOUNT_PAISE) so promotional or campaign renewal rates don't
  // affect new-QR purchases. Renewal is currently NOT surfaced to
  // customers — the product is a one-time purchase — but the config
  // and endpoints remain in case that changes.
  renewal: {
    amountPaise: parseInt(process.env.RENEWAL_AMOUNT_PAISE || '9900', 10),
  },
  // Line-item breakdown for the invoice email + payment screen. Sum
  // must equal DEFAULT_AMOUNT_PAISE (₹549). Split from the total so
  // the invoice shows Platform + Shipping as distinct line items —
  // matches how the price is advertised on the marketing page.
  pricing: {
    platformFeePaise: parseInt(process.env.PLATFORM_FEE_PAISE || '49900', 10),
    shippingFeePaise: parseInt(process.env.SHIPPING_FEE_PAISE || '5000', 10),
  },
  // Live-mode smoke test override. When set to a positive integer (in
  // paise), every Razorpay order is created with THIS amount instead
  // of whatever the caller requested — a way to validate the live
  // credential + full payment round-trip while charging only ₹1.
  // Unset it (or set to '') the moment testing is done — otherwise
  // every real customer is charged the test amount instead of ₹299.
  testChargeAmountPaise: (() => {
    const raw = (process.env.TEST_CHARGE_AMOUNT_PAISE || '').trim();
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })(),
  // Home-page promo video. Point PROMO_VIDEO_URL at any HTTPS MP4 (Supabase
  // Storage signed URL, S3, CloudFront, etc.). If unset, the app hides the
  // section — safe default for local dev.
  promoVideo: {
    url: process.env.PROMO_VIDEO_URL || '',
    title: process.env.PROMO_VIDEO_TITLE || 'See how it works',
    subtitle:
      process.env.PROMO_VIDEO_SUBTITLE ||
      'A 60-second walkthrough of QR 4 Emergency.',
    poster: process.env.PROMO_VIDEO_POSTER || '',
  },
  // Firebase Admin service-account JSON. Paste the entire JSON downloaded
  // from Firebase Console → Project Settings → Service accounts as a
  // single-line string in the env var. If unset, push notifications
  // silently no-op (DB rows still land in `notifications`).
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  // Exotel SMS credentials. When SMS_PROVIDER=exotel, all five values
  // below are required — the send helper fails closed (logs + no send)
  // if any is missing so we don't fire raw SMS with a broken header.
  //   sid       — Account SID (Exotel Dashboard → Settings)
  //   apiKey    — API key used as HTTP Basic username
  //   apiToken  — API token used as HTTP Basic password
  //   sender    — DLT-approved 6-char header e.g. "CPNETW"
  //   entityId  — DLT Principal Entity ID (required by Airtel/Jio/VI)
  //   subdomain — regional API host, "api.in.exotel.com" for India
  //
  // stripWs() removes ALL whitespace (including internal newlines).
  // Render's env editor wraps long strings visually; if a value gets
  // pasted with an accidental newline in the middle, .trim() wouldn't
  // catch it and HTTP Basic auth would silently fail with 401. Exotel
  // ids/keys/tokens never legitimately contain whitespace, so stripping
  // it out defensively is safe.
  exotel: (() => {
    const stripWs = (s) => (s || '').replace(/\s+/g, '');
    return {
      sid: stripWs(process.env.EXOTEL_SID),
      apiKey: stripWs(process.env.EXOTEL_API_KEY),
      apiToken: stripWs(process.env.EXOTEL_API_TOKEN),
      sender: stripWs(process.env.EXOTEL_SENDER) || 'CPNETW',
      entityId: stripWs(process.env.EXOTEL_DLT_ENTITY_ID),
      subdomain: stripWs(process.env.EXOTEL_SUBDOMAIN) || 'api.in.exotel.com',
    };
  })(),
};

export function assertConfig() {
  if (!config.databaseUrl && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  if (!config.databaseUrl) {
    console.warn('Warning: DATABASE_URL not set. Database operations will fail.');
  }
  // Refuse to boot with the dev-only JWT secret in production — otherwise
  // an env var typo silently signs tokens with a public string and anyone
  // can forge admin tokens.
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.JWT_SECRET || '';
    // Common weak values that would boot without complaint but are
    // effectively public. Reject any of them, plus anything under 32
    // characters (well below the strength of an HMAC-SHA256 key).
    const WEAK = new Set([
      '', 'dev-only-change-me', 'your-secret-key-change-this',
      'secret', 'changeme', 'change-me',
    ]);
    if (WEAK.has(secret) || secret.length < 32) {
      throw new Error(
        'JWT_SECRET is missing or too weak for production. ' +
          'Set a random ≥32-char string (e.g. `openssl rand -hex 32`).'
      );
    }
  }

  // Prod-mode escape hatches that must NEVER be active with real users.
  // Refuse to boot rather than silently backdoor everyone's account or
  // charge everyone ₹1 instead of the real subscription price.
  if (process.env.NODE_ENV === 'production') {
    if (config.devStaticOtp) {
      throw new Error(
        'DEV_STATIC_OTP must be unset in production — refusing to boot with a shared login backdoor.'
      );
    }
    if (config.testChargeAmountPaise > 0) {
      throw new Error(
        `TEST_CHARGE_AMOUNT_PAISE=${config.testChargeAmountPaise} must be unset in production — refusing to boot with a payment-amount override.`
      );
    }
  }

  // Renewal amount sanity check. Below 100 paise (₹1) is Razorpay's own
  // minimum; anything less would 400 at order-create time. Catch it at
  // boot so a typo in RENEWAL_AMOUNT_PAISE doesn't only surface when a
  // real customer tries to renew.
  if (!Number.isFinite(config.renewal.amountPaise) || config.renewal.amountPaise < 100) {
    throw new Error(
      `RENEWAL_AMOUNT_PAISE=${config.renewal.amountPaise} is below Razorpay minimum (100 paise / ₹1)`
    );
  }
  // Loud warning if the static-OTP escape hatch is enabled — so we don't
  // silently ship a "1234 works for everyone" backdoor into production.
  if (config.devStaticOtp) {
    console.warn(
      `[config] WARNING: DEV_STATIC_OTP is set to "${config.devStaticOtp}". ` +
      `Every user can log in with this code. Unset it once SMS_PROVIDER is live.`
    );
  }
  // Same loud warning for the payment override — real customers would
  // otherwise be charged ₹1 (or whatever this is) instead of the real
  // subscription price. This is a debug knob, not a production feature.
  if (config.testChargeAmountPaise > 0) {
    console.warn(
      `[config] WARNING: TEST_CHARGE_AMOUNT_PAISE=${config.testChargeAmountPaise} ` +
      `— EVERY Razorpay order will charge this amount, not the real price. ` +
      `Unset when you're done testing.`
    );
  }
}
