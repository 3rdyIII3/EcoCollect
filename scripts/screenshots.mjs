/**
 * Screenshots authenticated pages by driving Chrome over the DevTools Protocol.
 *
 * A cookie-seeding page does not work here: the session cookie is HttpOnly, so
 * document.cookie cannot create it. CDP Network.setCookie can, which means the
 * authenticated UI actually renders - the only way to catch a React render error on
 * a page the API tests cannot see.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.screenshots');
const PORT = 4404;
const DEBUG_PORT = 9333;
const base = `http://localhost:${PORT}`;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Long enough to satisfy the 12-character policy, and dev-only: this script talks
// to a throwaway PGlite database.
const SCREENSHOT_PASSWORD = 'screenshot-run-password';

mkdirSync(outDir, { recursive: true });

/* ---------------------------------------------------- start the app */
const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: root,
  env: { ...process.env, APP_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

for (let i = 0; i < 60; i += 1) {
  try { await fetch(`${base}/api/auth/csrf`); break; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}

/* ------------------------------------------------------- sign in */
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const save = (res) => {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
};

const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { cookie: cookie() } });
save(csrfRes);
const { csrfToken } = await csrfRes.json();

/** Fetches the login page's security question and computes its answer. */
async function solveCaptcha() {
  const res = await fetch(`${base}/api/auth/captcha`, { headers: { cookie: cookie() } });
  save(res);
  const { question } = await res.json().catch(() => ({}));
  const m = /^(\d+) ([+\u2212-]) (\d+)$/.exec(String(question || '').trim());
  if (!m) throw new Error(`could not solve the security question: ${question}`);
  const [, a, op, b] = m;
  return op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
}

/** Signs in, returning the parsed body. */
async function signIn(password) {
  const captcha = await solveCaptcha();
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, cookie: cookie() },
    body: JSON.stringify({ username: 'admin', password, captcha }),
  });
  save(res);
  console.log('login status:', res.status);
  return { res, body: await res.json().catch(() => null) };
}

/* The seeded admin is flagged must_change_password, and the client router bounces
   such an account to /change-password. Complete the change here so the screenshots
   show the authenticated pages rather than the forced-change form every time. */
let login = await signIn('admin123');
if (login.body?.user?.must_change_password) {
  const change = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('ecol_csrf'), cookie: cookie() },
    body: JSON.stringify({ current_password: 'admin123', new_password: SCREENSHOT_PASSWORD }),
  });
  console.log('password change status:', change.status);
  // Re-authenticate: the old session is still valid, but a fresh one keeps the
  // cookie jar consistent with what the browser will be handed.
  login = await signIn(SCREENSHOT_PASSWORD);
}

/* --------------------------------------------------------- Chrome */
const profile = path.join(outDir, 'cdp-profile');
const chromeProc = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* not up yet */ }
}
if (!wsUrl) {
  console.error('could not attach to Chrome');
  server.kill(); chromeProc.kill(); process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('CDP websocket failed'));
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  // Surface anything the page complains about: a React render crash shows up here
  // as a console error or an exception, which API-level tests cannot see.
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description
      || msg.params.exceptionDetails?.text || 'unknown exception');
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
});

// The session cookie, installed the way a browser would hold it.
const url = new URL(base);
for (const [name, value] of jar) {
  if (!name.startsWith('ecol_')) continue;
  await send('Network.setCookie', {
    name,
    value,
    domain: url.hostname,
    path: '/',
    httpOnly: name === 'ecol_session',
    sameSite: 'Lax',
  });
}

async function shoot(name, routePath, { height = 1100 } = {}) {
  consoleErrors.length = 0;
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: `${base}${routePath}` });
  await new Promise((r) => setTimeout(r, 4500));
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`${name}: ${existsSync(file) ? 'captured' : 'FAILED'}${consoleErrors.length ? ` (${consoleErrors.length} console error(s))` : ''}`);
  if (consoleErrors.length) consoleErrors.slice(0, 4).forEach((e) => console.log(`    ! ${String(e).slice(0, 200)}`));
}

await shoot('react-dashboard', '/dashboard');
await shoot('react-collections', '/collections', { height: 900 });
await shoot('react-barangays', '/barangays', { height: 900 });

// SPA deep link: proves the rewrite serves index.html for a nested client route.
await shoot('react-deeplink-barangay-edit', '/barangay-edit/1', { height: 700 });

/* The two sign-in pages, captured signed out. Both redirect to /dashboard when a
   session cookie is present, so the session is cleared for these two shots and then
   restored - otherwise the sign-in screens are the hardest thing to screenshot. */
await send('Network.clearBrowserCookies');
await shoot('react-login', '/login', { height: 900 });
await shoot('react-admin-login', '/admin/login', { height: 900 });

const url2 = new URL(base);
for (const [name, value] of jar) {
  if (!name.startsWith('ecol_')) continue;
  await send('Network.setCookie', {
    name,
    value,
    domain: url2.hostname,
    path: '/',
    httpOnly: name === 'ecol_session',
    sameSite: 'Lax',
  });
}

ws.close();
chromeProc.kill();
server.kill();
console.log(`\nscreenshots in ${outDir}`);
process.exit(0);
