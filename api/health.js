import { one, localTz, isDriverInjected } from './_lib/db.js';
import { withErrorHandling, send } from './_lib/http.js';

/**
 * GET /api/health
 *
 * Reports whether a deployment is correctly configured, so a broken deploy can be
 * diagnosed in one request instead of by decoding 500s from the UI.
 *
 * This exists because the most common deployment failure - a missing or too-short
 * JWT_SECRET - surfaces only as a generic "Internal server error" on the login
 * request, which tells an operator nothing. Without this endpoint the only place the
 * real message appears is the Vercel function log.
 *
 * It deliberately reports *presence and length only, never values*. A missing
 * JWT_SECRET is safe to disclose; the secret itself is not.
 *
 * Consider restricting this to your own IP or an internal header if you would rather
 * not expose configuration state publicly.
 */
export default withErrorHandling(async (req, res) => {
  const checks = [];
  let ok = true;

  const record = (name, pass, detail) => {
    checks.push({ name, pass, ...(detail ? { detail } : {}) });
    if (!pass) ok = false;
  };

  // JWT_SECRET is the one that breaks the login page with no useful message.
  const secret = process.env.JWT_SECRET || '';
  record(
    'JWT_SECRET',
    secret.length >= 32,
    secret ? `set, ${secret.length} chars (need 32+)` : 'not set',
  );
  // A trailing space or newline from a copy-paste is the classic way to be "almost".
  if (secret && secret.length >= 32 && secret !== secret.trim()) {
    record('JWT_SECRET_trimmed', false, 'has leading/trailing whitespace - re-save it trimmed');
  }

  // During local development the dev server injects PGlite instead of using
  // DATABASE_URL, so report the database as satisfied in that case rather than
  // crying wolf about a variable that is intentionally absent.
  const injected = isDriverInjected();
  record(
    'DATABASE_URL',
    Boolean(process.env.DATABASE_URL) || injected,
    injected && !process.env.DATABASE_URL
      ? 'not set (local dev is using the injected PGlite database)'
      : process.env.DATABASE_URL
        ? 'set'
        : 'not set',
  );

  let tzOk = true;
  let tzDetail = process.env.APP_TIMEZONE || 'unset, defaulting to Asia/Manila';
  try {
    localTz();
  } catch (err) {
    tzOk = false;
    tzDetail = err.message;
  }
  record('APP_TIMEZONE', tzOk, tzDetail);

  // Only worth querying when a driver is actually configured.
  if (process.env.DATABASE_URL || injected) {
    try {
      const row = await one(
        'SELECT COUNT(*)::int AS tables FROM information_schema.tables WHERE table_schema = $1',
        ['public'],
      );
      const count = Number(row?.tables ?? 0);
      record('database_reachable', true, `${count} table(s) in public schema`);
      record(
        'schema_applied',
        count > 0,
        count > 0 ? 'schema present' : 'no tables - run: npm run db:migrate',
      );
    } catch (err) {
      record('database_reachable', false, err.message.slice(0, 160));
    }
  }

  send(res, ok ? 200 : 503, { ok, checks });
}, ['GET']);