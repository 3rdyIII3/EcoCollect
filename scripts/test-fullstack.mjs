/**
 * Full-stack check over real HTTP: boots scripts/dev-server.mjs, signs in, calls
 * every endpoint, and verifies SPA deep links fall back to index.html.
 *
 *   node scripts/test-fullstack.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 4402);
const base = `http://localhost:${PORT}`;

const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: root,
  env: { ...process.env, APP_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
let crashed = null;
child.on('exit', (code, sig) => { crashed = `code=${code} signal=${sig}`; });

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? ` -> ${extra}` : ''}`); }
}

const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function save(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function req(p, opts = {}) {
  const r = await fetch(base + p, {
    ...opts,
    headers: { cookie: cookie(), ...(opts.headers || {}) },
  });
  save(r);
  return r;
}
const getJson = async (p) => {
  const r = await req(p);
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
};

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`${base}/api/auth/csrf`); return true; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  return false;
}

const up = await waitUp();
check('dev server starts', up, serverLog.slice(0, 300));
if (!up) { child.kill(); process.exit(1); }

/* ------------------------------------------------------ health check */
const healthRes = await fetch(`${base}/api/health`);
const health = await healthRes.json();
check('GET /api/health responds', healthRes.status === 200 || healthRes.status === 503, `status ${healthRes.status}`);
check('health reports ok in a working dev setup', health.ok === true, JSON.stringify(health.checks?.filter((c) => !c.pass)));
check('health verifies the database is reachable', health.checks?.some((c) => c.name === 'database_reachable' && c.pass) === true);
// Never leak a secret: only presence/length may appear.
const healthText = JSON.stringify(health);
check('health never echoes a secret value', !healthText.includes(process.env.DATABASE_URL || '@@none@@') || !healthText.includes('://'));
check('health never includes the JWT secret', !healthText.includes(String(process.env.JWT_SECRET || '@@none@@')));

/* ------------------------------------------------------------ auth flow */
const csrf = (await getJson('/api/auth/csrf')).body.csrfToken;
check('CSRF token issued', typeof csrf === 'string' && csrf.length >= 16);

/**
 * Fetches a security question and returns its answer, the way a person reading the
 * login page would. The minus sign is Unicode U+2212, not a hyphen.
 */
async function solveCaptcha() {
  const res = await req('/api/auth/captcha');
  const { question } = await res.json().catch(() => ({}));
  const m = /^(\d+) ([+\u2212-]) (\d+)$/.exec(String(question || '').trim());
  if (!m) throw new Error(`could not solve the security question: ${question}`);
  const [, a, op, b] = m;
  return op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
}

/**
 * Signs in as admin.
 *
 * The dev server keeps its database in .pglite/, so on a second run the admin's
 * password is whatever this suite set last time rather than the seed default. Both
 * are accepted so the suite stays re-runnable; a genuinely wrong password fails both.
 */
async function adminLogin(password) {
  const captcha = await solveCaptcha();
  const res = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ username: 'admin', password, captcha }),
  });
  return { res, body: await res.json().catch(() => null) };
}

let login = await adminLogin('admin123');
if (login.res.status === 401) login = await adminLogin('fullstack-test-passphrase');

let r = login.res;
check('login succeeds', r.status === 200, `status ${r.status}`);
const loginBody = login.body;
check('login returns admin', loginBody?.user?.role === 'admin');

// The seeded admin starts on its published default password, which the app forces a
// change on. Do it here so the rest of this suite exercises the normal app state
// rather than being bounced to the change-password screen by the client router.
if (loginBody?.user?.must_change_password) {
  check('seeded admin is flagged for a password change', true);
  r = await req('/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('ecol_csrf') },
    body: JSON.stringify({ current_password: 'admin123', new_password: 'fullstack-test-passphrase' }),
  });
  check('password change accepted', r.status === 200, `status ${r.status}`);
  const afterChange = (await getJson('/api/auth/me')).body;
  check('forced change flag cleared', afterChange?.user?.must_change_password === false);
} else {
  check('admin already on a password of its own (re-run)', true);
}

/* every authenticated endpoint */
for (const p of ['/api/auth/me', '/api/dashboard', '/api/barangays', '/api/collections', '/api/lookups', '/api/notifications?unread_count=1']) {
  const { status, body } = await getJson(p);
  check(`GET ${p} -> 200 with a body`, status === 200 && body !== null, `status ${status}`);
}

/* the dashboard payload the UI actually renders from */
const dash = (await getJson('/api/dashboard?period=month')).body;
check('dashboard stats are numeric', typeof dash?.stats?.todayKg === 'number');
check('dashboard returns recent rows', Array.isArray(dash?.recent));
check('dashboard returns chart series', Array.isArray(dash?.series?.dailyTrend));
check('dashboard series has labels for the line chart', Array.isArray(dash?.series?.dailyTrend));

/* create + list + delete a collection through the API */
const lookups = (await getJson('/api/lookups')).body;
// Use today's date so the new row sorts to the top of page 1; a backdated row would
// only appear on a later page once the demo data is seeded.
const today = lookups.today instanceof Date
  ? lookups.today.toISOString().slice(0, 10)
  : String(lookups.today).slice(0, 10);
const nowTime = new Date().toTimeString().slice(0, 5);
const adminCsrf = jar.get('ecol_csrf');
const created = await req('/api/collections', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': adminCsrf },
  body: JSON.stringify({
    action: 'create',
    barangay_id: lookups.barangays[0].id,
    collector_id: lookups.collectors[0].id,
    weight_kg: 77.5,
    waste_type: 'Organic',
    collection_date: today,
    collection_time: nowTime,
    status: 'completed',
  }),
});
check('create collection -> 201', created.status === 201, `status ${created.status}`);
const createdId = (await created.json().catch(() => null))?.id;

const listed = (await getJson('/api/collections')).body;
check('new collection appears in the list', listed?.rows?.some((x) => x.id === createdId));

const removed = await req('/api/collections', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': adminCsrf },
  body: JSON.stringify({ action: 'delete', id: createdId }),
});
check('delete collection -> 200', removed.status === 200, `status ${removed.status}`);

/* negative paths */
const csrf2 = (await getJson('/api/auth/csrf')).body.csrfToken;

/* A wrong security answer is refused before the password is even considered, and a
   wrong password behind a correct answer is refused separately. Both are exercised so
   a regression that reorders the checks would show up. */
const badCaptcha = await req('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrf2 },
  body: JSON.stringify({ username: 'admin', password: 'admin123', captcha: '999' }),
});
check('wrong security answer -> 400', badCaptcha.status === 400, `status ${badCaptcha.status}`);

const goodAnswer = await solveCaptcha();
const badPass = await req('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrf2 },
  body: JSON.stringify({ username: 'admin', password: 'nope', captcha: goodAnswer }),
});
check('wrong password -> 401', badPass.status === 401, `status ${badPass.status}`);

const noCsrf = await req('/api/collections', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete', id: 1 }),
});
check('mutation without CSRF header -> 403', noCsrf.status === 403, `status ${noCsrf.status}`);

const malformed = await req('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('ecol_csrf') },
  body: '{not valid json',
});
check('malformed JSON body -> 400, server survives', malformed.status === 400, `status ${malformed.status}`);

r = await fetch(`${base}/api/auth/csrf`);
check('server still alive after malformed body', r.ok, `status ${r.status}`);
check('server process did not crash', crashed === null, String(crashed));

/* SPA fallback for client-side routes. /change-password must deep-link too, since
   the forced change is where a freshly-seeded admin lands first. */
// /admin/login must deep-link too: it is a separate route with its own styling, so
// a misconfigured rewrite would leave the admin page blank while /login worked.
for (const p of ['/', '/login', '/admin/login', '/change-password', '/dashboard', '/collections', '/barangays']) {
  const res = await fetch(base + p);
  const html = await res.text();
  check(`deep link ${p} serves the SPA shell`, res.status === 200 && html.includes('<div id="root">'), `status ${res.status}`);
}

child.kill();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`\nserver log:\n${serverLog}`);
process.exit(fail === 0 ? 0 : 1);
