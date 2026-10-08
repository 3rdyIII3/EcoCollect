/**
 * Populates the local PGlite database with realistic demo data, so the dashboard
 * charts have something to draw. Dev-only; touches nothing on a hosted database.
 *
 *   node scripts/seed-demo.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await PGlite.create({ dataDir: path.join(root, '.pglite') });

const count = async (t) => (await db.query(`SELECT COUNT(*)::int AS v FROM ${t}`)).rows[0].v;
if ((await count('users')) === 0) {
  console.error('No users found. Start the dev server once first (npm run dev:full).');
  process.exit(1);
}

/* More collectors, so the performance chart has several bars.
   Cost 12 to match login.js. must_change_password is left false: these are local
   demo accounts and the forced change would get in the way of the charts. */
const pw = await bcrypt.hash('collectme', 12);
const people = [
  ['maria', 'Maria Santos', 'collector'],
  ['pedro', 'Pedro Reyes', 'collector'],
  ['superv', 'Rosel Supervisor', 'supervisor'],
];
for (const [username, fullName, role] of people) {
  await db.query(
    `INSERT INTO users (username, password, full_name, role)
     VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
    [username, pw, fullName, role],
  );
  if (role === 'collector') {
    await db.query(
      `INSERT INTO collectors (user_id, employee_id, route, vehicle_type)
       SELECT id, $2, $3, 'Motorcycle' FROM users WHERE username = $1
       ON CONFLICT (user_id) DO NOTHING`,
      [username, `EMP-${username.toUpperCase().slice(0, 4)}`, `Route ${username[0].toUpperCase()}`],
    );
  }
}

const collectors = (await db.query(`SELECT id FROM collectors ORDER BY id`)).rows.map((r) => r.id);
const barangays = (await db.query(`SELECT id FROM barangays ORDER BY id`)).rows.map((r) => r.id);
console.log(`${collectors.length} collectors, ${barangays.length} barangays`);

if (!collectors.length || !barangays.length) {
  console.error('Need at least one collector and one barangay.');
  process.exit(1);
}

/* 45 days of collections so every period filter has data. */
const types = ['Organic', 'Plastic', 'Residual', 'Recyclable', 'Hazardous', 'Mixed'];
const statuses = ['completed', 'completed', 'completed', 'partial', 'missed'];
let inserted = 0;

await db.query('DELETE FROM collections');

for (let back = 44; back >= 0; back -= 1) {
  const day = new Date();
  day.setDate(day.getDate() - back);
  const date = day.toISOString().slice(0, 10);
  // Skip some days so the trend line has realistic gaps.
  if (back % 7 === 3) continue;

  const perDay = 1 + (back % 3);
  for (let k = 0; k < perDay; k += 1) {
    const barangay = barangays[(back + k) % barangays.length];
    const collector = collectors[(back + k) % collectors.length];
    const weight = Math.round((45 + ((back * 17 + k * 29) % 120)) * 10) / 10;
    const hour = String(6 + ((back + k) % 10)).padStart(2, '0');
    const minute = k % 2 ? '30' : '00';
    await db.query(
      `INSERT INTO collections
         (barangay_id, collector_id, weight_kg, waste_type, bags_count,
          collection_date, collection_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [barangay, collector, weight, types[(back + k) % types.length],
        2 + ((back + k) % 7), date, `${hour}:${minute}`,
        statuses[(back + k) % statuses.length]],
    );
    inserted += 1;
  }
}

/* A schedule per barangay per collection day, so the expected-slot maths behind the
   completion-rate tile has something real to divide by. */
await db.query('DELETE FROM schedules');
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
for (const [i, b] of barangays.entries()) {
  // Not every barangay is collected on every day, which is what makes the number useful.
  for (const day of DAYS.filter((_, di) => (di + i) % 2 === 0)) {
    const collector = collectors[(i + DAYS.indexOf(day)) % collectors.length];
    await db.query(
      `INSERT INTO schedules (barangay_id, collector_id, day_of_week, time_start, time_end, route_name)
       VALUES ($1,$2,$3,'06:00','12:00',$4)`,
      [b, collector, day, `Route ${String.fromCharCode(65 + i)}`],
    );
  }
}
await db.query(
  `INSERT INTO dumping_reports (reporter_name, reporter_contact, description, address, status)
   SELECT 'Resident A', '09171234567',
          'Illegal dumping of construction materials along the roadside',
          'Zone 1, San Isidro', 'pending'
   WHERE NOT EXISTS (SELECT 1 FROM dumping_reports)`,
);
await db.query(
  `INSERT INTO notifications (title, message, type)
   SELECT 'System Alert', 'Monthly waste report is ready for review', 'info'
   WHERE NOT EXISTS (SELECT 1 FROM notifications)`,
);

console.log(`inserted ${inserted} collections across 45 days`);
console.log('start the app with: npm run dev:full');
await db.close();
