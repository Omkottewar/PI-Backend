// Admin API key middleware.
//
// Set ADMIN_API_KEY in your environment (locally in .env, on Render in the
// service's Env Vars). Every /api/admin/* route requires that key sent via:
//
//   - Header:  X-Admin-Key: <key>
//   - Header:  Authorization: Bearer <key>
//
// If the env var isn't set at all, the middleware refuses to authorize
// anyone — safer than accidentally leaving admin open when a deploy env
// misses the var.
export function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({
      error: 'Admin API not configured (ADMIN_API_KEY env var missing)',
    });
  }

  let provided = req.headers['x-admin-key'];
  if (!provided) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      provided = auth.slice(7);
    }
  }

  if (!provided || String(provided) !== adminKey) {
    return res.status(401).json({ error: 'Invalid or missing admin key' });
  }
  next();
}
