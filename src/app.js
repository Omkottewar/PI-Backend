import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import qrRoutes from './routes/qr.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import alertRoutes from './routes/alert.routes.js';
import appRoutes from './routes/app.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import exotelRoutes from './routes/exotel.routes.js';
import exotelCallbackRoutes from './routes/exotelCallback.routes.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  if (hasBody && req.body && Object.keys(req.body).length) {
    try {
      bodyPreview = ' body=' + JSON.stringify(redact(req.body)).slice(0, 500);
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

app.use('/auth', authRoutes);
app.use('/profile', profileRoutes);
app.use('/qr', qrRoutes);
app.use('/payments', paymentRoutes);
app.use('/api/app', appRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/exotel', exotelRoutes);
app.use('/api/exotel', exotelCallbackRoutes);


import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Alert web + APIs — GET page, POST verify, POST call */
app.use('/alert', alertRoutes);

app.get('/call/:callId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/receiver-link.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
