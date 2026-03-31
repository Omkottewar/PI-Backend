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
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
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
