import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import qrRoutes from './routes/qr.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import alertRoutes from './routes/alert.routes.js';
import appRoutes from './routes/app.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import exotelRoutes from './routes/exotel.routes.js';
import exotelCallbackRoutes from './routes/exotelCallback.routes.js';
import razorpayWebhookRoutes from './routes/razorpayWebhook.routes.js';
import adminRoutes from './routes/admin.routes.js';

const app = express();

// Trust Render's proxy so req.ip is the real client, not the LB. Required
// for express-rate-limit to key on the actual caller.
app.set('trust proxy', 1);

// Security headers. `contentSecurityPolicy: false` keeps the inline
// scripts inside alert-page.html and admin.html working — we render
// those pages ourselves so a bespoke CSP is safe to skip for now.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors());

// Razorpay's webhook body must be HMAC-verified against the EXACT bytes
// Razorpay signed. If express.json() runs first it consumes the stream
// and populates req.body as a parsed object, so signature verification
// gets an empty rawBody, the response hangs, and Razorpay retries. Mount
// a path-scoped express.raw() BEFORE the global JSON parser so
// req.body is a Buffer containing the exact signed bytes.
app.use('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ──────────────────────────────────────────────────────
// Two tiers:
//   • Sensitive (auth + alert): 30/min/IP — enough for a human, tight
//     enough that OTP/scan enumeration is impractical.
//   • Global: 300/min/IP — safety net for everything else.
// The middleware runs before route handlers, so any request past the
// limit fails fast with 429.
const authAlertLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again in a minute' },
});
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again in a minute' },
});
app.use(globalLimiter);

// ─── Request / response tracer ──────────────────────────────────────────
// Prints one line per incoming request (method + path + optional body
// preview) and one per response (status + duration). Search Render logs
// with `[req]` or `[res]` to filter. Bodies are truncated to 500 chars
// and sensitive fields (otp, password, token, signatures) are redacted.
function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  const SENSITIVE = new Set([
    'otp', 'password', 'token', 'jwt', 'authorization',
    'razorpay_signature', 'razorpay_payment_id', 'razorpay_order_id',
  ]);
  for (const k of Object.keys(clone)) {
    if (SENSITIVE.has(k.toLowerCase())) {
      clone[k] = '[REDACTED]';
    } else if (clone[k] && typeof clone[k] === 'object') {
      clone[k] = redact(clone[k]);
    }
  }
  return clone;
}

app.use((req, res, next) => {
  const start = Date.now();
  const { method, originalUrl } = req;
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  let bodyPreview = '';
  if (hasBody && req.body) {
    try {
      // Buffer bodies (e.g. the Razorpay webhook where we use express.raw)
      // JSON-serialise to `{"0":123,"1":34,...}` which is unreadable.
      // Decode as UTF-8 for logging instead — the payload is JSON.
      if (Buffer.isBuffer(req.body)) {
        bodyPreview = ' body=' + req.body.toString('utf8').slice(0, 500);
      } else if (Object.keys(req.body).length) {
        bodyPreview = ' body=' + JSON.stringify(redact(req.body)).slice(0, 500);
      }
    } catch { /* ignore */ }
  }
  console.log(`[req] ${method} ${originalUrl}${bodyPreview}`);
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[res] ${method} ${originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authAlertLimiter, authRoutes);
app.use('/profile', profileRoutes);
app.use('/qr', qrRoutes);
app.use('/payments', paymentRoutes);
app.use('/api/app', appRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/exotel', exotelRoutes);
app.use('/api/exotel', exotelCallbackRoutes);
// Razorpay webhook — mounted OUTSIDE any auth middleware because
// Razorpay hits it directly with HMAC-signed payloads. The route
// verifies the signature itself.
app.use('/api/razorpay', razorpayWebhookRoutes);
app.use('/api/admin', adminRoutes);


import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Alert web + APIs — GET page, POST verify, POST call */
app.use('/alert', authAlertLimiter, alertRoutes);

// Admin single-page UI — the /api/admin/* routes are the actual backend.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Browser fallback for the expiry-countdown SMS "Renew via {web_link}" link.
// Owner enters mobile → OTP → picks a QR → Razorpay checkout → renewal.
app.get('/renew', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/renew.html'));
});

app.get('/call/:callId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/receiver-link.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
