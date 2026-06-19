import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import qrRoutes from './routes/qr.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import alertRoutes from './routes/alert.routes.js';
import callHistoryRoutes from './routes/callHistory.routes.js';
import appRoutes from './routes/app.routes.js';
import notificationRoutes from './routes/notification.routes.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/profile', profileRoutes);
app.use('/qr', qrRoutes);
app.use('/payments', paymentRoutes);
app.use('/api/call-history', callHistoryRoutes);
app.use('/api/app', appRoutes);
app.use('/api/notifications', notificationRoutes);


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
