import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  // `code: 'AUTH_INVALID'` marks the response as a genuine session
  // failure so the mobile client can distinguish it from unrelated 401s
  // (e.g., a passthrough from Razorpay or another upstream service).
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or invalid Authorization header',
      code: 'AUTH_INVALID',
    });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const id = parseInt(String(payload.sub), 10);
    if (!Number.isFinite(id)) {
      return res.status(401).json({
        error: 'Invalid token subject',
        code: 'AUTH_INVALID',
      });
    }
    req.userId = id;
    next();
  } catch {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'AUTH_INVALID',
    });
  }
}
