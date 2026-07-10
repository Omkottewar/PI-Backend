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
  publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
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
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production');
  }
}
