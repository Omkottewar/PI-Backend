/**
 * Map node-postgres / connection errors to API-friendly payloads.
 */
export function databaseErrorResponse(err) {
  if (!err) return null;
  const msg = String(err.message || '');

  if (err.code === '28P01' || msg.includes('password authentication failed')) {
    return {
      status: 503,
      error: 'PostgreSQL rejected the database username or password.',
      hint:
        'Set DATABASE_URL to a valid role. With the included Docker DB: postgresql://postgres:postgres@localhost:5432/emergency_alert — run `docker compose up -d` in the backend folder, then `npm run migrate`.',
    };
  }

  if (err.code === 'ECONNREFUSED') {
    return {
      status: 503,
      error: 'Cannot reach PostgreSQL (connection refused).',
      hint: 'Start PostgreSQL or run `docker compose up -d` in the backend folder.',
    };
  }

  if (err.code === '3D000' || msg.includes('does not exist')) {
    return {
      status: 503,
      error: 'Database does not exist.',
      hint: 'Create database `emergency_alert` or use `docker compose up -d`, then `npm run migrate`.',
    };
  }

  if (err.code === '42P01') {
    return {
      status: 503,
      error: 'Database tables are missing.',
      hint: 'Run `npm run migrate` after the database is up.',
    };
  }

  return null;
}
