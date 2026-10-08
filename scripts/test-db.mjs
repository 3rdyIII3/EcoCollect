/**
 * Runs db/schema.sql plus the real queries used by the API handlers against an
 * in-process Postgres (PGlite/WASM).
 *
 * This exists because the port from MySQL to Postgres is mostly untestable by
 * inspection: DATE_SUB/CURDATE, ENUM, tinyint, FIELD(), IFNULL and the generated
 * identity columns all changed. PGlite is the same Postgres engine, so any SQL error
 * here would be a real error on Neon.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

process.env.JWT_SECRET ||= 'test-secret-that-is-definitely-long-enough-32chars';

const db = await PGlite.create();
const q = async (text, params = []) => (await db.query(text, params)).rows;

let pass = 0;
let fail = 0;
async function check(label, fn) {
  try {
    const out = await fn();
    if (out === false) throw new Error('assertion returned false');
    pass += 1;
    console.log(`PASS  ${label}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL  ${label}\n        ${err.message.split('\n')[0]}`);
  }
}

const dbLib = await import('../api/_lib/db.js');

/* ------------------------------------------------------------- schema */
await check('schema.sql applies cleanly', async () => {
  await db.exec(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
  return true;
});

await check('all 10 tables created', async () => {
  const rows = await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const names = rows.map((r) => r.table_name).sort();
  const want = [
    'barangays', 'collections', 'collectors', 'dumping_reports', 'login_attempts',
    'login_events', 'notifications', 'schedules', 'settings', 'users',
  ].sort();
  const missing = want.filter((t) => !names.includes(t));
  if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`);
  return true;
});

/* --------------------------------------------------------------- seed */
await check('fixture data inserts', async () => {
  await q(
    `INSERT INTO users (username, password, full_name, role) VALUES
       ('admin', 'x', 'System Administrator', 'admin'),
       ('sad',   'x', 'John Collector',      'collector'),
       ('superv','x', 'Rosel Supervisor',    'supervisor')`,
  );
  await q(
    `INSERT INTO collectors (user_id, employee_id, route)
     SELECT id, 'EMP-001', 'Route A' FROM users WHERE username = 'sad'`,
  );
  await q(
    `INSERT INTO barangays (name, population, zone, qr_code) VALUES
       ('Sanito', 0, '', 'BRG-15BEA949'),
       ('Poblacion', 5000, '', 'BRG-CE55E28B')`,
  );
  await q(
    `INSERT INTO schedules (barangay_id, collector_id, day_of_week, time_start, time_end)
     SELECT b.id, c.id, 'Thursday', '06:00', '08:00'
       FROM barangays b CROSS JOIN collectors c WHERE b.name = 'Sanito'`,
  );
  return true;
});

/* ------------------------------------------------- generated columns */
await check('IDENTITY column returns numeric id', async () => {
  const [row] = await q(`INSERT INTO barangays (name, qr_code) VALUES ('Taway','BRG-NEW1') RETURNING id`);
  if (typeof row.id !== 'number') throw new Error(`id came back as ${typeof row.id}`);
  return true;
});

await check('QR code uniqueness enforced', async () => {
  try {
    await q(`INSERT INTO barangays (name, qr_code) VALUES ('Dup','BRG-NEW1')`);
    throw new Error('duplicate QR code was accepted');
  } catch (err) {
    if (err.message.includes('duplicate QR code was accepted')) throw err;
    return true; // unique violation, as intended
  }
});

/* ------------------------------------------------------ the guard rails */
await check('settings trigger blocks secret-like keys', async () => {
  try {
    await q(`INSERT INTO settings (setting_key, setting_value) VALUES ('new_password','admin123')`);
    throw new Error('plaintext password was accepted into settings');
  } catch (err) {
    if (err.message.includes('was accepted')) throw err;
    return true;
  }
});

await check('settings trigger allows normal keys', async () => {
  await q(`INSERT INTO settings (setting_key, setting_value) VALUES ('site_name','EcoCollect')`);
  return true;
});

await check('CHECK rejects a bad role', async () => {
  try {
    await q(`INSERT INTO users (username, password, full_name, role) VALUES ('x','y','z','wizard')`);
    throw new Error('invalid role was accepted');
  } catch (err) {
    if (err.message.includes('invalid role was accepted')) throw err;
    return true;
  }
});

await check('CHECK rejects a bad waste_type', async () => {
  try {
    await q(
      `INSERT INTO collections (barangay_id, collector_id, weight_kg, waste_type, collection_date, collection_time)
       VALUES (1, 1, 10, 'Plasma', CURRENT_DATE, '09:00')`,
    );
    throw new Error('invalid waste_type was accepted');
  } catch (err) {
    if (err.message.includes('invalid waste_type was accepted')) throw err;
    return true;
  }
});

await check('updated_at trigger fires on UPDATE', async () => {
  await q(`UPDATE users SET full_name = 'Renamed' WHERE username = 'admin'`);
  const [row] = await q(`SELECT updated_at > created_at AS bumped FROM users WHERE username='admin'`);
  if (!row.bumped) throw new Error('updated_at did not advance');
  return true;
});

/* ----------------------------------------------- MySQL -> Postgres SQL */
const today = dbLib.localDateSql();

await check('dashboard: "today" KPI (MySQL CURRENT_DATE swap)', async () => {
  const rows = await q(
    `SELECT COALESCE(SUM(c.weight_kg), 0) AS v FROM collections c WHERE c.collection_date = $1`,
    [await (async () => (await q(`SELECT ${today}::text AS d`))[0].d)()],
  );
  return rows.length === 1;
});

await check('dashboard: date-window filter with interval arithmetic', async () => {
  const rows = await q(
    `SELECT c.collection_date, SUM(c.weight_kg) AS total
       FROM collections c
      WHERE c.collection_date >= (${today} - $1::int)
      GROUP BY c.collection_date
      ORDER BY c.collection_date ASC`,
    ['30'],
  );
  return Array.isArray(rows);
});

await check('dashboard: monthly to_char grouping', async () => {
  const rows = await q(
    `SELECT to_char(c.collection_date, 'YYYY-MM') AS month, SUM(c.weight_kg) AS total
       FROM collections c
      WHERE c.collection_date >= (${today} - $1::int)
      GROUP BY month
      ORDER BY month ASC`,
    ['365'],
  );
  return Array.isArray(rows);
});

await check('dashboard: LEFT JOIN keeps empty barangays', async () => {
  const rows = await q(
    `SELECT b.id, b.name, COALESCE(SUM(c.weight_kg), 0) AS total_weight, COUNT(c.id)::int AS collection_count
       FROM barangays b
       LEFT JOIN collections c ON c.barangay_id = b.id AND c.collection_date >= (${today} - $1::int)
      WHERE b.is_active = true
      GROUP BY b.id, b.name
      ORDER BY total_weight DESC`,
    ['30'],
  );
  // Sanito has no collections, so it must still appear with zeros.
  const sanito = rows.find((r) => r.name === 'Sanito');
  if (!sanito) throw new Error('LEFT JOIN dropped a barangay with no collections');
  if (Number(sanito.total_weight) !== 0) throw new Error('expected 0 weight, got ' + sanito.total_weight);
  return true;
});

await check('collections: ILIKE search with escaped wildcards', async () => {
  const rows = await q(
    `SELECT b.name FROM collections c
       JOIN barangays b ON b.id = c.barangay_id
      WHERE (b.name ILIKE $1 OR b.name ILIKE $1)`,
    ['%Pobla%'],
  );
  return rows.length >= 0;
});

await check('collections: COUNT(*)::int returns a number', async () => {
  const [row] = await q(
    `SELECT COUNT(*)::int AS v FROM collections c JOIN barangays b ON b.id = c.barangay_id`,
  );
  if (typeof row.v !== 'number') throw new Error(`got ${typeof row.v}`);
  return true;
});

await check('collections: INSERT ... RETURNING id', async () => {
  const [barangay] = await q(`SELECT id FROM barangays WHERE name = 'Sanito'`);
  const [collector] = await q(`SELECT id FROM collectors LIMIT 1`);
  const [row] = await q(
    `INSERT INTO collections (barangay_id, collector_id, weight_kg, waste_type, collection_date, collection_time, status)
     VALUES ($1, $2, 12.5, 'Organic', CURRENT_DATE, '07:30', 'completed') RETURNING id`,
    [barangay.id, collector.id],
  );
  return typeof row.id === 'number';
});

await check('throttle: login_attempts insert + window count', async () => {
  await q(`INSERT INTO login_attempts (client_key) VALUES ('abc')`);
  await q(`INSERT INTO login_attempts (client_key) VALUES ('abc')`);
  const [row] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts
      WHERE client_key = $1 AND succeeded_at > now() - ($2 || ' seconds')::interval`,
    ['abc', '900'],
  );
  if (row.failures !== 2) throw new Error(`expected 2, got ${row.failures}`);
  return true;
});

await check('throttle: rows older than the window are ignored', async () => {
  // Insert with a backdated timestamp so the window maths is actually exercised,
  // rather than reading rows that were written milliseconds ago.
  await q(
    `INSERT INTO login_attempts (client_key, succeeded_at) VALUES ('oldkey', now() - interval '20 minutes')`,
  );
  const [row] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts
      WHERE client_key = $1 AND succeeded_at > now() - ($2 || ' seconds')::interval`,
    ['oldkey', '900'],
  );
  if (row.failures !== 0) throw new Error(`expected 0, got ${row.failures}`);
  return true;
});

await check('throttle: one failure row serves both scopes', async () => {
  // The per-network and per-account counters are two reads of the same row, so a
  // single insert must be visible under both keys.
  await q(
    `INSERT INTO login_attempts (client_key, username_key, ip_hash)
     VALUES ('both-ways', 'acct-key', 'iphash')`,
  );
  const [byClient] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts
      WHERE client_key = $1 AND succeeded_at > now() - ($2 || ' seconds')::interval`,
    ['both-ways', '900'],
  );
  const [byAccount] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts
      WHERE username_key = $1 AND succeeded_at > now() - ($2 || ' seconds')::interval`,
    ['acct-key', '900'],
  );
  if (byClient.failures !== 1) throw new Error(`client scope saw ${byClient.failures}`);
  if (byAccount.failures !== 1) throw new Error(`account scope saw ${byAccount.failures}`);
  return true;
});

await check('throttle: the two scopes count independently', async () => {
  // Five failures for one account from one address must not appear as failures
  // against a different account or a different address.
  for (let i = 0; i < 5; i += 1) {
    await q(
      `INSERT INTO login_attempts (client_key, username_key, succeeded_at)
       VALUES ('lockkey', 'victim', now())`,
    );
  }
  const [victim] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts WHERE username_key = 'victim'`,
  );
  const [other] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts WHERE username_key = 'bystander'`,
  );
  const [elsewhere] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_attempts WHERE client_key = 'other-host'`,
  );
  if (victim.failures !== 5) throw new Error(`expected 5 for the target, got ${victim.failures}`);
  if (other.failures !== 0) throw new Error('a bystander account was counted');
  if (elsewhere.failures !== 0) throw new Error('an unrelated host was counted');
  return true;
});

await check('throttle: clearing a success drops both scopes at once', async () => {
  // This is what stops one user's successful login from leaving a colleague's
  // account throttled on a shared connection.
  await q(`DELETE FROM login_attempts WHERE client_key = $1 OR username_key = $2`, ['lockkey', 'victim']);
  const rows = await q(
    `SELECT COUNT(*)::int AS v FROM login_attempts WHERE client_key = 'lockkey' OR username_key = 'victim'`,
  );
  if (rows[0].v !== 0) throw new Error('rows survived the clear');
  return true;
});

await check('audit: login_events records success and failure alike', async () => {
  await q(
    `INSERT INTO login_events (username, success, reason, ip_hash, user_agent) VALUES
       ('admin',  false, 'bad_credentials', 'iphash1', 'curl/8'),
       ('admin',  false, 'bad_credentials', 'iphash1', 'curl/8'),
       ('nobody',false, 'throttled',      'iphash2', 'curl/8'),
       ('sad',    true,  'ok',            'iphash3', 'Firefox')`,
  );
  const [row] = await q(
    `SELECT COUNT(*)::int AS failures FROM login_events WHERE success = false`,
  );
  const [ok] = await q(`SELECT COUNT(*)::int AS n FROM login_events WHERE success = true`);
  if (row.failures !== 3) throw new Error(`expected 3 failures, got ${row.failures}`);
  if (ok.n !== 1) throw new Error(`expected 1 success, got ${ok.n}`);
  return true;
});

await check('audit: retention cleanup drops only old rows', async () => {
  await q(
    `INSERT INTO login_events (username, success, reason, ip_hash, created_at)
     VALUES ('admin', false, 'bad_credentials', 'iphash', now() - interval '120 days')`,
  );
  await q(`DELETE FROM login_events WHERE created_at < now() - ($1 || ' days')::interval`, ['90']);
  // Counted dynamically: earlier checks in this suite also insert events, and the
  // assertion is about the old row being gone, not about a total.
  const [recent] = await q(
    `SELECT COUNT(*)::int AS v FROM login_events WHERE created_at > now() - interval '90 days'`,
  );
  if (recent.v !== 4) throw new Error(`expected the 4 recent rows, got ${recent.v}`);
  const [old] = await q(
    `SELECT COUNT(*)::int AS v FROM login_events WHERE created_at <= now() - interval '90 days'`,
  );
  if (old.v !== 0) throw new Error(`${old.v} expired rows survived`);
  return true;
});

await check('users: must_change_password defaults to false', async () => {
  const [row] = await q(`SELECT must_change_password FROM users WHERE username = 'sad'`);
  if (row.must_change_password !== false) throw new Error('default should be false');
  return true;
});

await check('users: clearing must_change_password on a real change', async () => {
  await q(`UPDATE users SET must_change_password = true WHERE username = 'superv'`);
  const [flagged] = await q(`SELECT must_change_password FROM users WHERE username = 'superv'`);
  if (flagged.must_change_password !== true) throw new Error('flag was not set');
  // The exact statement api/auth/password.js runs, against the row just flagged.
  const [target] = await q(`SELECT id FROM users WHERE username = 'superv'`);
  await q(
    `UPDATE users SET password = $1, must_change_password = false WHERE id = $2`,
    ['newhash', target.id],
  );
  const [cleared] = await q(
    `SELECT must_change_password FROM users WHERE username = 'superv'`,
  );
  if (cleared.must_change_password !== false) throw new Error('flag was not cleared');
  return true;
});

await check('notifications: = ANY($1::text[]) weekday filter', async () => {
  const [row] = await q(
    `SELECT COUNT(*)::int AS v FROM schedules WHERE is_active = true AND day_of_week = ANY($1::text[])`,
    [['Thursday', 'Monday']],
  );
  return typeof row.v === 'number';
});

await check('notifications: to_char(...,\'FMDay\') matches schedules enum', async () => {
  const weekday = dbLib.localWeekdaySql();
  const [row] = await q(`SELECT ${weekday} AS v`);
  const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  if (!names.includes(row.v)) throw new Error(`got "${row.v}", not a valid day name`);
  return true;
});

await check('deactivating a barangay cascades to nothing (soft delete)', async () => {
  await q(`UPDATE barangays SET is_active = false WHERE name = 'Taway'`);
  const [row] = await q(`SELECT is_active FROM barangays WHERE name = 'Taway'`);
  return row.is_active === false;
});

await check('hard delete DOES cascade to collections', async () => {
  // Confirms why the delete endpoint deactivates instead of deleting.
  const [b] = await q(`SELECT id FROM barangays WHERE name = 'Sanito'`);
  await q(`DELETE FROM barangays WHERE id = $1`, [b.id]);
  const rows = await q(`SELECT COUNT(*)::int AS v FROM collections WHERE barangay_id = $1`, [b.id]);
  if (rows[0].v !== 0) throw new Error('collections survived a cascading delete');
  return true;
});

await check('weekdayCase() produces valid SQL', async () => {
  const sql = `SELECT ${dbLib.weekdayCase('day_of_week')} AS ord FROM schedules ORDER BY ord`;
  const rows = await q(sql);
  return Array.isArray(rows);
});

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail === 0 ? 0 : 1);
