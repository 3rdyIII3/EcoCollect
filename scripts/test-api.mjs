/**
 * Boots the real handlers against a PGlite database and exercises them as HTTP
 * requests, so the whole request path is covered: cookies, CSRF, auth, SQL.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.JWT_SECRET = 'test-secret-that-is-definitely-long-enough-32chars';
process.env.APP_TIMEZONE = 'Asia/Manila';
// Keeps cookies Secure-free and HSTS off, matching how the dev server runs.
process.env.NODE_ENV = 'development';

const pglite = await PGlite.create();
await pglite.exec(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));

/* Deliberately hashed at cost 10, not the app's current 12. A real database would
   arrive with cost-10 hashes from the PHP original, and that is exactly the case
   the rehash-on-login path exists for - so the fixture reproduces it and the
   upgrade assertion below is testing the real scenario rather than a no-op. */
await pglite.query('INSERT INTO users (username, password, full_name, role) VALUES ($1,$2,$3,$4)',
  ['admin', await bcrypt.hash('admin123', 10), 'System Administrator', 'admin']);
await pglite.query('INSERT INTO users (username, password, full_name, role) VALUES ($1,$2,$3,$4)',
  ['sad', await bcrypt.hash('collectme', 10), 'John Collector', 'collector']);
// A third account, used only by the password-oracle tests at the end. Keeping it
// separate means throttling it cannot affect the admin session used elsewhere.
await pglite.query('INSERT INTO users (username, password, full_name, role) VALUES ($1,$2,$3,$4)',
  ['probe', await bcrypt.hash('probe-original-pw', 10), 'Probe Account', 'collector']);
await pglite.query(`INSERT INTO collectors (user_id, employee_id, route) SELECT id,'EMP-9','Route Z' FROM users WHERE username='probe'`);
await pglite.query(`INSERT INTO collectors (user_id, employee_id, route) SELECT id,'EMP-1','Route A' FROM users WHERE username='sad'`);
await pglite.query(`INSERT INTO barangays (name, population, zone, qr_code) VALUES ('Poblacion',5000,'','BRG-TEST01'),('Sanito',0,'','BRG-TEST02')`);

/* Point the db layer at PGlite.
   `neon()` returns the rows array directly, whereas PGlite returns { rows, fields },
   so wrap it in an adapter. Without this the handler code under test would silently
   see zero rows - the adapter keeps the handlers byte-identical to production. */
const dbLib = await import(pathToFileURL(path.join(root, 'api', '_lib', 'db.js')).href);
dbLib.__setDriverForTests({
  query: async (text, params) => (await pglite.query(text, params)).rows,
});

const handlers = {
  csrf: (await import(pathToFileURL(path.join(root, 'api/auth/csrf.js')).href)).default,
  captcha: (await import(pathToFileURL(path.join(root, 'api/auth/captcha.js')).href)).default,
  login: (await import(pathToFileURL(path.join(root, 'api/auth/login.js')).href)).default,
  logout: (await import(pathToFileURL(path.join(root, 'api/auth/logout.js')).href)).default,
  me: (await import(pathToFileURL(path.join(root, 'api/auth/me.js')).href)).default,
  password: (await import(pathToFileURL(path.join(root, 'api/auth/password.js')).href)).default,
  dashboard: (await import(pathToFileURL(path.join(root, 'api/dashboard.js')).href)).default,
  collections: (await import(pathToFileURL(path.join(root, 'api/collections.js')).href)).default,
  barangays: (await import(pathToFileURL(path.join(root, 'api/barangays.js')).href)).default,
  lookups: (await import(pathToFileURL(path.join(root, 'api/lookups.js')).href)).default,
  notifications: (await import(pathToFileURL(path.join(root, 'api/notifications.js')).href)).default,
};

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? ` -> ${extra}` : ''}`); }
}

/** Minimal stand-in for Vercel's req/res. */
function makeRes() {
  const res = {
    statusCode: null, body: null, headers: {},
    headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(s, h = {}) { this.statusCode = s; this.headersSent = true; Object.entries(h).forEach(([k, v]) => { this.headers[k.toLowerCase()] = v; }); },
    end(b) { this.headersSent = true; if (b !== undefined) this.body = typeof b === 'string' ? b : JSON.stringify(b); },
  };
  return res;
}
async function call(handler, { method = 'GET', cookies = {}, body, query = {}, ip = '1.2.3.4', ua = 'test', headers: extra = {} } = {}) {
  const req = {
    method,
    url: `/api/x?${new URLSearchParams(query)}`,
    headers: {
      ...(Object.keys(cookies).length ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      'user-agent': ua,
      'x-forwarded-for': ip,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    body,
    query,
  };
  const res = makeRes();
  await handler(req, res);
  let parsed = res.body;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { /* keep raw (svg) */ } }
  return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.body };
}
function setCookies(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return {};
  const list = Array.isArray(raw) ? raw : [raw];
  const jar = {};
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return jar;
}

/* ==================================================== unauthenticated */
let r = await call(handlers.me);
check('GET /me anonymous -> user null', r.status === 200 && r.body.user === null);

for (const [name, h] of [['dashboard', handlers.dashboard], ['collections', handlers.collections], ['barangays', handlers.barangays], ['lookups', handlers.lookups]]) {
  r = await call(h);
  check(`GET /${name} anonymous -> 401`, r.status === 401, `got ${r.status}`);
}

r = await call(handlers.dashboard, { cookies: { ecol_session: 'forged.token.here' } });
check('forged session token -> 401', r.status === 401, `got ${r.status}`);

/* ==================================================== csrf gate */
r = await call(handlers.login, { method: 'POST', body: { username: 'admin', password: 'admin123', captcha: '1' } });
check('login without CSRF -> 403', r.status === 403, `got ${r.status}`);

const c = (await call(handlers.csrf)).body.csrfToken;
check('csrf endpoint returns a long token', typeof c === 'string' && c.length >= 16, String(c).slice(0, 12));

r = await call(handlers.login, { method: 'POST', cookies: { ecol_csrf: c }, headers: { 'x-csrf-token': 'wrong' }, body: { username: 'admin', password: 'admin123', captcha: '1' } });
check('login with mismatched CSRF header -> 403', r.status === 403, `got ${r.status}`);

/* ==================================================== captcha gate */
r = await call(handlers.login, { method: 'POST', cookies: { ecol_csrf: c }, headers: { 'x-csrf-token': c }, body: { username: 'admin', password: 'admin123' } });
check('login with no captcha answer -> 400', r.status === 400, `got ${r.status}`);
check('missing captcha names the security question', /security question/i.test(r.body?.error || ''), String(r.body?.error));

// The endpoint returns the question and nothing else - no answer, no hint.
const capRes = await call(handlers.captcha);
check('captcha returns a question', typeof capRes.body?.question === 'string', JSON.stringify(capRes.body));
check('captcha response carries no answer field', !('answer' in (capRes.body || {})), JSON.stringify(Object.keys(capRes.body || {})));
const capCookies = setCookies(capRes.headers);
check('captcha sets its cookie', Boolean(capCookies.ecol_captcha));
check('captcha cookie is httpOnly', String(capRes.headers['set-cookie']).includes('HttpOnly'));

// Solves "a + b" / "a − b" the way a person reading the screen would. The minus sign is
// a Unicode U+2212, not a hyphen, which is exactly the sort of detail a test should
// pin down rather than assume.
function solve(question) {
  const m = /^(\d+) ([+\u2212-]) (\d+)$/.exec(String(question || '').trim());
  if (!m) throw new Error(`unparseable question: ${question}`);
  const [, a, op, b] = m;
  return op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
}
const solved = solve(capRes.body.question);

// A wrong answer is refused before the database is touched, and burns the challenge.
r = await call(handlers.login, { method: 'POST', cookies: { ...capCookies, ecol_csrf: c }, headers: { 'x-csrf-token': c }, body: { username: 'admin', password: 'admin123', captcha: String(solved === 999 ? 998 : solved + 1) } });
check('login with a wrong captcha -> 400', r.status === 400, `got ${r.status}`);
check('failed attempt expires the captcha cookie', String(r.headers['set-cookie']).includes('ecol_captcha=;'));

/* A wrong captcha must NOT count toward the throttle, or anyone could lock a user out
   by submitting wrong answers with no password knowledge at all. Proved by burning
   several wrong answers and confirming the account is still not throttled after. */
const badCapC = (await call(handlers.csrf)).body.csrfToken;
for (let i = 0; i < 6; i += 1) {
  const bad = await call(handlers.captcha);
  await call(handlers.login, {
    method: 'POST', ip: '3.3.3.3', ua: 'captcha-spam',
    cookies: { ...setCookies(bad.headers), ecol_csrf: badCapC }, headers: { 'x-csrf-token': badCapC },
    body: { username: 'admin', password: 'admin123', captcha: '999' },
  });
}
check('wrong captchas do not throttle the account', (await pglite.query(
  `SELECT COUNT(*)::int AS v FROM login_attempts WHERE username_key <> ''`,
)).rows[0].v === 0, 'a wrong captcha created throttle rows');

/* ======================================================== login gate */
const cap1 = await call(handlers.captcha);
r = await call(handlers.login, { method: 'POST', cookies: { ...setCookies(cap1.headers), ecol_csrf: c }, headers: { 'x-csrf-token': c }, body: { username: 'admin', password: 'admin123', captcha: String(solve(cap1.body.question)) } });
check('login with a solved captcha -> 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
check('login returns the user', r.body?.user?.role === 'admin');
check('login returns a csrf token', typeof r.body?.csrfToken === 'string');
check('successful login clears the captcha cookie', String(r.headers['set-cookie']).includes('ecol_captcha=;'));

const session = setCookies(r.headers);
check('session cookie is httpOnly', String(r.headers['set-cookie']).includes('HttpOnly'));
check('session cookie present', Boolean(session.ecol_session));

/* The fixture hash above is deliberately cost 10, so this first successful login is
   the rehash path: the stored hash must come back at the new cost without the
   password changing or the login failing. */
const upgraded = (await pglite.query(`SELECT password FROM users WHERE username = 'admin'`)).rows[0].password;
check('cost-10 hash upgraded on successful login', /^\$2[aby]\$12\$/.test(upgraded), upgraded.slice(0, 7));
check('upgraded hash still verifies the same password', await bcrypt.compare('admin123', upgraded), true);
check('login response has no forced-change flag', r.body?.user?.must_change_password === false);

/* ==================================================== authenticated */
r = await call(handlers.me, { cookies: session });
check('GET /me with session -> admin', r.body?.user?.role === 'admin');

r = await call(handlers.dashboard, { cookies: session });
check('GET /dashboard -> 200', r.status === 200, `got ${r.status}`);
check('dashboard returns stats', typeof r.body?.stats?.todayKg === 'number');
check('dashboard returns series for staff', Array.isArray(r.body?.series?.wasteByType));
check('dashboard has 4 chart series', ['wasteByType','dailyTrend','monthlyTrend','wasteByCollector'].every((k) => Array.isArray(r.body?.series?.[k])));

r = await call(handlers.dashboard, { cookies: session, query: { period: 'week' } });
check('dashboard period=week accepted', r.status === 200);
r = await call(handlers.dashboard, { cookies: session, query: { period: 'bogus' } });
check('dashboard rejects bad period', r.status === 400, `got ${r.status}`);

r = await call(handlers.barangays, { cookies: session });
check('GET /barangays -> 2 rows', r.status === 200 && r.body.rows.length === 2, `got ${r.status}/${r.body?.rows?.length}`);

r = await call(handlers.collections, { cookies: session });
check('GET /collections -> 200', r.status === 200, `got ${r.status}`);
check('collections returns pagination', typeof r.body?.pagination?.total === 'number');

/* --- create a collection */
const adminCsrf = session.ecol_csrf;

r = await call(handlers.collections, { method: 'POST', cookies: session, headers: { 'x-csrf-token': adminCsrf }, body: { action: 'create', barangay_id: 1, collector_id: 1, weight_kg: 42.5, waste_type: 'Plastic', collection_date: '2026-07-23', collection_time: '09:30', status: 'completed' } });
check('create collection -> 201', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
const newId = r.body?.id;

r = await call(handlers.collections, { method: 'POST', cookies: session, headers: { 'x-csrf-token': adminCsrf }, body: { action: 'create', barangay_id: 1, collector_id: 1, weight_kg: -5, collection_date: '2026-07-23', collection_time: '09:30' } });
check('create rejects negative weight -> 400', r.status === 400, `got ${r.status}`);

r = await call(handlers.collections, { method: 'POST', cookies: session, headers: { 'x-csrf-token': adminCsrf }, body: { action: 'create', barangay_id: 1, collector_id: 1, weight_kg: 10, waste_type: 'Plasma', collection_date: '2026-07-23', collection_time: '09:30' } });
check('create rejects unknown waste_type -> 400', r.status === 400, `got ${r.status}`);

r = await call(handlers.collections, { method: 'POST', cookies: session, headers: { 'x-csrf-token': adminCsrf }, body: { action: 'create', barangay_id: 1, collector_id: 1, weight_kg: 10, collection_date: '23-07-2026', collection_time: '09:30' } });
check('create rejects malformed date -> 400', r.status === 400, `got ${r.status}`);

r = await call(handlers.collections, { method: 'POST', cookies: session, headers: { 'x-csrf-token': adminCsrf }, body: { action: 'create', barangay_id: 1, collector_id: 1, weight_kg: 10, collection_date: '2026-07-23', collection_time: '25:99' } });
check('create rejects malformed time -> 400', r.status === 400, `got ${r.status}`);

r = await call(handlers.collections, { method: 'POST', cookies: session, headers: { 'x-csrf-token': adminCsrf }, body: { action: 'delete', id: newId } });
check('delete collection -> 200', r.status === 200, `got ${r.status}`);

/* --- barangay permissions: collector must be refused */
const cc = (await call(handlers.csrf, { cookies: {} })).body.csrfToken;
const colCap = await call(handlers.captcha);
const lr = await call(handlers.login, { method: 'POST', cookies: { ...setCookies(colCap.headers), ecol_csrf: cc }, headers: { 'x-csrf-token': cc }, body: { username: 'sad', password: 'collectme', captcha: String(solve(colCap.body.question)) } });
check('collector can log in', lr.status === 200, `${lr.status} ${JSON.stringify(lr.body)}`);
const colSession = setCookies(lr.headers);

r = await call(handlers.barangays, { method: 'POST', cookies: colSession, body: { action: 'create', name: 'Hack', qr_code: 'BRG-X' } });
check('collector cannot create barangay -> 403', r.status === 403, `got ${r.status}`);

r = await call(handlers.dashboard, { cookies: colSession });
check('collector dashboard hides series', r.body?.series === null);
check('collector pendingReports is null', r.body?.stats?.pendingReports === null);

r = await call(handlers.notifications, { cookies: colSession });
check('collector gets empty notification list', r.status === 200 && r.body.items.length === 0);

r = await call(handlers.lookups, { cookies: colSession });
check('collector lookups scoped to self', r.body?.collectors?.length === 1, `got ${r.body?.collectors?.length}`);

/* --- inactive user is refused */
await pglite.query(`UPDATE users SET is_active = false WHERE username = 'sad'`);
r = await call(handlers.me, { cookies: colSession });
check('deactivated user /me -> null', r.body?.user === null);

/* --- admin deactivation takes effect on an existing session */
await pglite.query(`UPDATE users SET is_active = false WHERE username = 'admin'`);
r = await call(handlers.me, { cookies: session });
check('deactivated admin session stops working', r.body?.user === null);

/* --- logout clears cookies */
await pglite.query(`UPDATE users SET is_active = true WHERE username = 'admin'`);
r = await call(handlers.logout, { method: 'POST', cookies: session });
check('logout clears session cookie', String(r.headers['set-cookie']).includes('Max-Age=0'));

/* --- escalating throttle
   The first 3 failures are treated as typos and never lock, so a shared office
   connection cannot be locked out by a colleague's mistakes. The 4th onward
   doubles the wait, and a locked client is told how long to wait via
   Retry-After rather than being given a flat 15-minute wall. */
const lockC = (await call(handlers.csrf)).body.csrfToken;
/* Each attempt carries a correctly-solved captcha, so what is being measured is the
   credential throttle alone rather than a captcha rejection. */
const badFrom = async (ip, ua = 'test', username = 'admin') => {
  const cap = await call(handlers.captcha, { ip, ua });
  return call(handlers.login, {
    method: 'POST', ip, ua,
    cookies: { ...setCookies(cap.headers), ecol_csrf: lockC },
    headers: { 'x-csrf-token': lockC },
    body: { username, password: 'wrong-on-purpose', captcha: String(solve(cap.body.question)) },
  });
};

const first = await badFrom('9.9.9.9');
check('first wrong password -> 401, no lockout', first.status === 401, `got ${first.status}`);
check('no Retry-After before the lockout', !first.headers['retry-after']);

await badFrom('9.9.9.9');
await badFrom('9.9.9.9');
check('three failures still no lockout', (await badFrom('9.9.9.9')).status === 401);

const locked = await badFrom('9.9.9.9');
check('fourth failure starts the backoff', locked.status === 429, `got ${locked.status}`);
check('locked response carries Retry-After', Boolean(locked.headers['retry-after']), String(locked.headers['retry-after']));
check('Retry-After is at least 30s', Number(locked.headers['retry-after']) >= 30, String(locked.headers['retry-after']));

/* A correct password while locked must still be refused - otherwise the lockout
   would only slow an attacker who is already winning. */
const lockedCap = await call(handlers.captcha, { ip: '9.9.9.9' });
const stillLocked = await call(handlers.login, {
  method: 'POST', ip: '9.9.9.9',
  cookies: { ...setCookies(lockedCap.headers), ecol_csrf: lockC },
  headers: { 'x-csrf-token': lockC },
  body: { username: 'admin', password: 'admin123', captcha: String(solve(lockedCap.body.question)) },
});
check('valid password refused while locked', stillLocked.status === 429, `got ${stillLocked.status}`);

/* Per-account scope: a different address guessing the same username is throttled
   too. This is the credential-stuffing case the per-IP counter alone misses. */
const otherIp = await badFrom('8.8.4.4', 'stuffer');
check('account is locked from a different address too', otherIp.status === 429, `got ${otherIp.status}`);

/* A different account from the same locked address is refused on the network scope,
   which the failures above have already pushed past the first threshold. */
const differentUser = await badFrom('9.9.9.9', 'test', 'superv');
check('network scope covers other accounts', differentUser.status === 429, `got ${differentUser.status}`);

/* A clean client elsewhere is unaffected by any of it. `sad` was deactivated
   earlier in this suite to prove deactivation is immediate, so reactivate it. */
await pglite.query(`UPDATE users SET is_active = true WHERE username = 'sad'`);
const cleanCap = await call(handlers.captcha, { ip: '5.5.5.5', ua: 'fresh-browser' });
const clean = await call(handlers.login, {
  method: 'POST', ip: '5.5.5.5', ua: 'fresh-browser',
  cookies: { ...setCookies(cleanCap.headers), ecol_csrf: lockC },
  headers: { 'x-csrf-token': lockC },
  body: { username: 'sad', password: 'collectme', captcha: String(solve(cleanCap.body.question)) },
});
check('an unrelated client can still log in', clean.status === 200, `${clean.status} ${JSON.stringify(clean.body)}`);

/* --- audit trail */
const events = await pglite.query(
  `SELECT username, success, reason, ip_hash FROM login_events ORDER BY id`,
);
check('failed attempts are recorded', events.rows.some((e) => !e.success && e.username === 'admin'));
check('successful logins are recorded', events.rows.some((e) => e.success && e.username === 'sad'));
check('throttled attempts are recorded as throttled', events.rows.some((e) => e.reason === 'throttled'));
// Distinguishing the two failure kinds is the point of logging them separately.
check('captcha failures recorded apart from credential failures', events.rows.some((e) => e.reason === 'bad_captcha'));
// The privacy property that matters: an audit log is still useful without ever
// putting a raw address on disk.
check('every attempt has a hashed address', events.rows.every((e) => typeof e.ip_hash === 'string' && e.ip_hash.length > 0));
const addresses = ['9.9.9.9', '8.8.4.4', '5.5.5.5', '7.7.7.7', '1.2.3.4'];
check(
  'no raw IP address is stored',
  !addresses.some((ip) => JSON.stringify(events.rows).includes(ip)),
);

/* --- forced password change, and the current-password check
   Uses `sad` rather than `admin` so the throttle assertions below do not lock out
   the account the rest of the suite still needs. */
await pglite.query(`UPDATE users SET must_change_password = true WHERE username = 'sad'`);
const changeCsrf = (await call(handlers.csrf)).body.csrfToken;
const pwCap = await call(handlers.captcha, { ip: '7.7.7.7', ua: 'pw-client' });
const before = await call(handlers.login, {
  method: 'POST', ip: '7.7.7.7', ua: 'pw-client',
  cookies: { ...setCookies(pwCap.headers), ecol_csrf: changeCsrf },
  headers: { 'x-csrf-token': changeCsrf },
  body: { username: 'sad', password: 'collectme', captcha: String(solve(pwCap.body.question)) },
});
check('login flags a default password', before.body?.user?.must_change_password === true);

const pwSession = setCookies(before.headers);
const pwCsrf = pwSession.ecol_csrf;

r = await call(handlers.password, {
  method: 'POST', cookies: pwSession, headers: { 'x-csrf-token': pwCsrf },
  body: { current_password: 'not-it', new_password: 'a-much-longer-passphrase' },
});
check('wrong current password refused', r.status === 401, `got ${r.status}`);

r = await call(handlers.password, {
  method: 'POST', cookies: pwSession, headers: { 'x-csrf-token': pwCsrf },
  body: { current_password: 'collectme', new_password: 'short' },
});
check('too-short new password refused', r.status === 400, `got ${r.status}`);

r = await call(handlers.password, {
  method: 'POST', cookies: pwSession, headers: { 'x-csrf-token': pwCsrf },
  body: { current_password: 'collectme', new_password: 'admin12345678' },
});
check('known-weak password refused', r.status === 400, `got ${r.status}`);

r = await call(handlers.password, {
  method: 'POST', cookies: pwSession, headers: { 'x-csrf-token': pwCsrf },
  body: { current_password: 'collectme', new_password: 'collectme-again-please' },
});
check('new password identical to current refused', r.status === 400, `got ${r.status}`);

r = await call(handlers.password, {
  method: 'POST', cookies: pwSession, headers: { 'x-csrf-token': pwCsrf },
  body: { current_password: 'collectme', new_password: 'a-much-longer-passphrase' },
});
check('valid change accepted', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

r = await call(handlers.me, { cookies: pwSession });
check('must_change_password cleared', r.body?.user?.must_change_password === false);

const reloginCsrf = (await call(handlers.csrf)).body.csrfToken;
const reloginCap = await call(handlers.captcha, { ip: '7.7.7.7', ua: 'pw-client' });
r = await call(handlers.login, {
  method: 'POST', ip: '7.7.7.7', ua: 'pw-client',
  cookies: { ...setCookies(reloginCap.headers), ecol_csrf: reloginCsrf },
  headers: { 'x-csrf-token': reloginCsrf },
  body: { username: 'sad', password: 'a-much-longer-passphrase', captcha: String(solve(reloginCap.body.question)) },
});
check('new password works', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
check('no forced change after the change', r.body?.user?.must_change_password === false);

/* --- the change endpoint is not a password oracle
   Probing the current password is password guessing, so a run of wrong guesses must
   trip the same throttle the login path uses. Uses its own account so locking it out
   cannot affect the admin session later in this suite. */
const probeCsrf = (await call(handlers.csrf)).body.csrfToken;
const probeCap = await call(handlers.captcha, { ip: '6.6.6.6', ua: 'probe-client' });
const probeLogin = await call(handlers.login, {
  method: 'POST', ip: '6.6.6.6', ua: 'probe-client',
  cookies: { ...setCookies(probeCap.headers), ecol_csrf: probeCsrf },
  headers: { 'x-csrf-token': probeCsrf },
  body: { username: 'probe', password: 'probe-original-pw', captcha: String(solve(probeCap.body.question)) },
});
check('probe account signed in', probeLogin.status === 200, `got ${probeLogin.status}`);
const probeSession = setCookies(probeLogin.headers);

let oracleStatus = 0;
for (let i = 0; i < 6; i += 1) {
  oracleStatus = (await call(handlers.password, {
    method: 'POST', cookies: probeSession, headers: { 'x-csrf-token': probeSession.ecol_csrf },
    body: { current_password: `guess-${i}`, new_password: 'a-much-longer-passphrase' },
  })).status;
}
check('password change is throttled by wrong guesses', oracleStatus === 429, `got ${oracleStatus}`);

r = await call(handlers.password, {
  method: 'POST', cookies: probeSession, headers: { 'x-csrf-token': probeSession.ecol_csrf },
  body: { current_password: 'probe-original-pw', new_password: 'a-much-longer-passphrase' },
});
check('locked out even with the right current password', r.status === 429, `got ${r.status}`);

/* A different address and account is unaffected by the above. */
const otherCsrf = (await call(handlers.csrf)).body.csrfToken;
const otherCap = await call(handlers.captcha, { ip: '4.4.4.4', ua: 'other-user' });
const otherLogin = await call(handlers.login, {
  method: 'POST', ip: '4.4.4.4', ua: 'other-user',
  cookies: { ...setCookies(otherCap.headers), ecol_csrf: otherCsrf },
  headers: { 'x-csrf-token': otherCsrf },
  body: { username: 'admin', password: 'admin123', captcha: String(solve(otherCap.body.question)) },
});
check('an unrelated admin session is not throttled', otherLogin.status === 200, `got ${otherLogin.status}`);
const otherSession = setCookies(otherLogin.headers);
r = await call(handlers.password, {
  method: 'POST', cookies: otherSession, headers: { 'x-csrf-token': otherSession.ecol_csrf },
  body: { current_password: 'admin123', new_password: 'another-long-passphrase' },
});
check('and can still change its own password', r.status === 200, `got ${r.status}`);

/* A password change must require a session. The user id is taken from the session
   token, so there is no body field here that could point it at another account. */
r = await call(handlers.password, {
  method: 'POST', cookies: { ecol_csrf: changeCsrf }, headers: { 'x-csrf-token': changeCsrf },
  body: { current_password: 'collectme', new_password: 'attacker-chosen-value', user_id: 1 },
});
check('password change without a session -> 401', r.status === 401, `got ${r.status}`);

r = await call(handlers.password, {
  method: 'POST', cookies: otherSession, headers: { 'x-csrf-token': otherSession.ecol_csrf },
  body: { current_password: 'another-long-passphrase', new_password: 'yet-another-passphrase', user_id: 2 },
});
check('a user_id in the body is ignored, not honoured', r.status === 200, `got ${r.status}`);

/* --- security headers on API responses */
r = await call(handlers.me);
check('X-Content-Type-Options sent', r.headers['x-content-type-options'] === 'nosniff');
check('X-Frame-Options sent', r.headers['x-frame-options'] === 'DENY');
check('Referrer-Policy sent', Boolean(r.headers['referrer-policy']));
check('no HSTS in development', !r.headers['strict-transport-security']);

console.log(`\n${pass} passed, ${fail} failed`);
await pglite.close();
process.exit(fail === 0 ? 0 : 1);
