/**
 * Applies db/schema.sql to DATABASE_URL, then optionally seeds demo data.
 *
 *   node db/migrate.mjs            # schema only (drops and recreates tables)
 *   node db/migrate.mjs --seed     # schema + demo rows
 *
 * WARNING: schema.sql begins with DROP TABLE ... CASCADE. This destroys all data.
 * Point it at a fresh Neon database, or take a dump first.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { neon } from '@neondatabase/serverless';

const here = path.dirname(fileURLToPath(import.meta.url));

const url =
  process.env.DATABASE_URL ||
  (await readFile(path.join(here, '..', '.env.local'), 'utf8')
    .then((t) => t.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim())
    .catch(() => null));

if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
  process.exit(1);
}

const sql = neon(url);

console.log('Applying schema (this DROPS existing tables)…');
await sql.query(await readFile(path.join(here, 'schema.sql'), 'utf8'));
console.log('Schema applied.');

if (!process.argv.includes('--seed')) {
  console.log('Done. Re-run with --seed to insert demo data.');
  process.exit(0);
}

console.log('Seeding demo data…');

/**
 * The seed password is published in the README, so every seeded account is flagged
 * must_change_password and the app refuses to do anything else until it is
 * replaced. Without this flag a deployment that forgot to change the default would
 * silently keep a publicly known admin password.
 *
 * Cost 12 matches login.js, so no seeded hash is weaker than one written later.
 */
const password = await bcrypt.hash('admin123', 12);

await sql.query(
  `INSERT INTO users (username, password, full_name, role, contact, email, must_change_password)
   VALUES
     ('admin', $1, 'System Administrator', 'admin', '09171234567', 'admin@ecocollect.local', true),
     ('superv', $1, 'Rosel Supervisor', 'supervisor', '09181234567', 'superv@ecocollect.local', true),
     ('sad',   $1, 'John Collector',   'collector', '09191234567', 'sad@ecocollect.local', false)
   ON CONFLICT (username) DO NOTHING`,
  [password],
);

const [collector] = await sql.query(
  `SELECT col.id FROM collectors col JOIN users u ON u.id = col.user_id WHERE u.username = 'sad'`,
);

await sql.query(
  `INSERT INTO collectors (user_id, employee_id, route, vehicle_type, vehicle_plate)
   SELECT id, 'EMP-001', 'Route A', 'Motorcycle', 'ABC-1234' FROM users WHERE username = 'sad'
   ON CONFLICT (user_id) DO NOTHING`,
);

await sql.query(
  `INSERT INTO barangays (name, population, zone, address, qr_code)
   VALUES
     ('Sanito',      0,    '', 'Sanito',                    'BRG-15BEA949'),
     ('Poblacion',   0,    '', 'Ipil Poblacion',            'BRG-CE55E28B'),
     ('Taway',       590,  '', 'Taway, Zamboanga Sibugay',  'BRG-3B36BFE3')
   ON CONFLICT (qr_code) DO NOTHING`,
);

if (collector?.id) {
  await sql.query(
    `INSERT INTO collections
       (barangay_id, collector_id, weight_kg, waste_type, collection_date, collection_time, status)
     SELECT b.id, $1, 568.00, 'Mixed', CURRENT_DATE - 1, '08:29', 'completed'
       FROM barangays b WHERE b.name = 'Poblacion'
     ON CONFLICT DO NOTHING`,
    [collector.id],
  );
}

await sql.query(
  `INSERT INTO settings (setting_key, setting_value) VALUES
     ('site_name', 'EcoCollect'),
     ('site_tagline', 'QR-Based Waste Collection Management System'),
     ('municipality', 'Municipality of Ipil'),
     ('collection_start_time', '06:00'),
     ('collection_end_time', '18:00'),
     ('max_weight_per_collection', '2000')
   ON CONFLICT (setting_key) DO NOTHING`,
);

// The MySQL database had plaintext passwords sitting in settings because the old
// handler saved every unrecognised POST field. schema.sql blocks secret-like keys,
// and this removes the leftovers if migrating an existing dataset.
await sql.query(
  `DELETE FROM settings
    WHERE setting_key ~* '(password|secret|token|csrf|api[_-]?key)'`,
);

console.log('Seed complete. Log in with  admin / admin123');
console.log('You will be required to choose a new password before you can use the app.');
