import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

const isSupabase = /supabase\.(co|com)/i.test(config.databaseUrl || '');

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  ssl: isSupabase ? { rejectUnauthorized: false } : false,
});
