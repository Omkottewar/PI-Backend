import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const id = parseInt(String(payload.sub), 10);
    if (!Number.isFinite(id)) {
      return res.status(401).json({ error: 'Invalid token subject' });
    }
    req.userId = id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
