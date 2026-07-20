import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '../../migrations');

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const isSupabase = /supabase\.(co|com)/i.test(databaseUrl);
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: isSupabase ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const filter = process.argv[2]; // optional: `npm run migrate -- 023`
    let files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    if (filter) {
      // Prefix match so `023`, `023_drop_legacy_extension_number`, or the
      // full filename all work. Errors out if nothing matches so a typo
      // doesn't silently no-op.
      const matches = files.filter((f) => f.startsWith(filter));
      if (matches.length === 0) {
        console.error(`No migration file starts with "${filter}"`);
        process.exit(1);
      }
      files = matches;
    }
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log('Running', file);
      await client.query(sql);
    }
    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
