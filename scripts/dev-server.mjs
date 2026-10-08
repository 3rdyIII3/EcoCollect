/**
 * Local full-stack dev server: serves the built frontend from dist/ and mounts the
 * real api/ handlers backed by an in-process Postgres (PGlite).
 *
 *   npm run build && npm run dev:full
 *
 * `vercel dev` is the canonical way to run this, but it needs the Vercel CLI and a
 * hosted database. This gives the same request path with nothing extra installed,
 * which is handy for working on the UI. Set APP_PORT to change the port.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.APP_PORT || 4321);

process.env.JWT_SECRET ||= 'dev-only-secret-that-is-at-least-32-characters-long';
process.env.APP_TIMEZONE ||= 'Asia/Manila';
// Set explicitly so cookies come out without Secure. The API now defaults to
// Secure unless it sees exactly this value, and localhost is served over plain
// http - a Secure cookie there would be silently dropped by the browser.
process.env.NODE_ENV ||= 'development';

// Reuse an existing .local database if one was created, so restarts keep your data.
const dataDir = path.join(root, '.pglite');
const db = await PGlite.create({ dataDir });

const applied = await db.query(
  `SELECT COUNT(*)::int AS v FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'`,
);
if (applied.rows[0].v === 0) {
  console.log('Creating schema…');
  await db.exec(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
  const hash = (await import('bcryptjs')).default;
  // Cost 12 to match login.js, so a hash written locally is never weaker than one
  // written in production.
  const pw = await hash.hash('admin123', 12);
  // must_change_password: the local admin is the same published-default account a
  // real deployment would start with, so the forced change is exercised here too.
  await db.query(
    `INSERT INTO users (username, password, full_name, role, must_change_password)
     VALUES ($1,$2,$3,$4,true)`,
    ['admin', pw, 'System Administrator', 'admin'],
  );
  await db.query(
    `INSERT INTO users (username, password, full_name, role) VALUES ($1,$2,$3,$4)`,
    ['sad', pw, 'John Collector', 'collector'],
  );
  await db.query(
    `INSERT INTO collectors (user_id, employee_id, route)
     SELECT id,'EMP-001','Route A' FROM users WHERE username='sad'`,
  );
  await db.query(
    `INSERT INTO barangays (name, population, zone, qr_code) VALUES
       ('Sanito',0,'','BRG-15BEA949'),('Poblacion',4200,'','BRG-CE55E28B'),('Taway',590,'','BRG-3B36BFE3')`,
  );
  console.log('Seeded. Log in with admin / admin123, then set your own password.');
}

// The neon() driver returns rows directly; PGlite returns { rows }, so adapt.
const dbLib = await import(pathToFileURL(path.join(root, 'api', '_lib', 'db.js')).href);
dbLib.__setDriverForTests({
  query: async (text, params) => (await db.query(text, params)).rows,
});

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href).then((m) => m.default);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const ROUTES = {
  '/api/health': 'api/health.js',
  '/api/auth/csrf': 'api/auth/csrf.js',
  '/api/auth/captcha': 'api/auth/captcha.js',
  '/api/auth/login': 'api/auth/login.js',
  '/api/auth/logout': 'api/auth/logout.js',
  '/api/auth/me': 'api/auth/me.js',
  '/api/auth/password': 'api/auth/password.js',
  '/api/dashboard': 'api/dashboard.js',
  '/api/collections': 'api/collections.js',
  '/api/barangays': 'api/barangays.js',
  '/api/lookups': 'api/lookups.js',
  '/api/notifications': 'api/notifications.js',
};

const server = createServer(async (req, res) => {
  // Wrap everything: an unhandled rejection inside an http request callback takes
  // the whole process down, so a bad request must never be able to kill the server.
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const route = ROUTES[url.pathname];

    if (route) {
      const handler = await load(route);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      req.body = undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD' && raw) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          // Hand it to the handler as-is; jsonBody() reports it as a 400 rather than
          // us crashing here.
          req.body = raw;
        }
      }
      req.query = Object.fromEntries(url.searchParams);
      await handler(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No handler for ${url.pathname}` }));
      return;
    }

    // Static files from dist/, falling back to index.html for client-side routes.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const distDir = path.join(root, 'dist');
    let file = path.join(distDir, rel);
    if (!file.startsWith(distDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(distDir, 'index.html');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Run `npm run build` first.');
    }
  } catch (err) {
    console.error('[dev-server]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  EcoCollect dev server  http://localhost:${PORT}`);
  console.log('  admin / admin123 (you will be asked to change it)\n');
});
