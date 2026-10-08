import crypto from 'node:crypto';
import { one, run } from './db.js';

/**
 * Login throttling for serverless.
 *
 * The PHP version kept counters in a JSON file per IP+UA in the system temp
 * directory. Neither a file nor an in-memory Map works here: functions are
 * ephemeral and there are many of them, so a Map would reset on every cold start
 * and give no real protection. Counters therefore live in Postgres, keyed by an
 * HMAC of IP + user agent so raw IPs are never stored.
 *
 * Two scopes are tracked from the same failure row, because they defend against
 * different attacks:
 *
 *   - per account (HMAC of the username) stops credential stuffing against one
 *     account from many source addresses.
 *   - per network (HMAC of IP + user agent) stops one host spraying many accounts.
 *
 * Lockout escalates rather than tripping at a fixed threshold. The old behaviour
 * locked a client out for a flat 15 minutes after 5 failures, which made trivial
 * denial of service: five wrong passwords from a colleague on the same office
 * connection locked out everyone behind that NAT for a quarter hour. Escalating
 * backoff costs a typo a couple of seconds and costs a script the full window.
 */
const WINDOW_SECONDS = 900; // 15 minutes

// Failures below this count never lock; they are just typos being counted.
const FREE_FAILURES = 3;
// First lockout, doubling from here, capped at the full window.
const BASE_LOCK_SECONDS = 30;
const MAX_LOCK_SECONDS = 900;

/**
 * Hashing a key so neither raw IPs nor usernames are stored in the table.
 *
 * Uses the same HMAC key (JWT_SECRET) as the session tokens but a different prefix
 * for each scope, so the two namespaces cannot collide and a key from one cannot be
 * replayed as the other. Cheap by design - this runs on every failed login.
 */
function key(value) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT_SECRET is not set'), { statusCode: 500 });
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Per-network scope.
 *
 * Truncated to 32 base64url chars (192 bits) rather than the full digest: it only
 * has to be a stable, non-reversible label, and a shorter key keeps the indexed
 * lookups cheap. The user agent is included so one office's NAT does not put every
 * employee in a shared bucket.
 */
function clientKey(ip, ua) {
  return key(`ip:${ip}|${ua}`).slice(0, 32);
}

function accountKey(username) {
  // Case-folded, because login matches usernames case-insensitively and `Admin`
  // must not get a fresh allowance by varying the capitalisation.
  return key(`user:${String(username || '').toLowerCase()}`).slice(0, 32);
}

/**
 * How long a client with this many recent failures must wait, in seconds.
 *
 * 0-3 failures: no lock at all.
 * 4: 30s, 5: 60s, 6: 120s, 7: 240s, 8: 480s, 9 and above: the full 15 minutes.
 */
export function lockSeconds(failures) {
  if (failures < FREE_FAILURES + 1) return 0;
  return Math.min(BASE_LOCK_SECONDS * 2 ** (failures - (FREE_FAILURES + 1)), MAX_LOCK_SECONDS);
}

/**
 * Recent failure count for one scope.
 *
 * `column` is interpolated, so it must only ever be a literal from this module -
 * the caller passes a value, never a column name. Both call sites below are
 * hardcoded, and both values are HMACs rather than usernames or addresses.
 */
async function failuresIn(column, value) {
  const row = await one(
    `SELECT COUNT(*)::int AS failures
       FROM login_attempts
      WHERE ${column} = $1
        AND succeeded_at > now() - ($2 || ' seconds')::interval`,
    [value, String(WINDOW_SECONDS)],
  );
  return row?.failures ?? 0;
}

/**
 * The current lockout for this login attempt, if any.
 *
 * Returns the longer of the two scopes so a caller only has to handle one value.
 */
export async function getLockout({ ip, ua, username }) {
  const [client, account] = await Promise.all([
    failuresIn('client_key', clientKey(ip, ua)),
    failuresIn('username_key', accountKey(username)),
  ]);

  const seconds = Math.max(lockSeconds(client), lockSeconds(account));
  if (seconds <= 0) return { locked: false, seconds: 0 };

  return {
    locked: true,
    seconds,
    // Which scope caused it, purely so the message and the audit log can say so.
    scope: lockSeconds(account) >= lockSeconds(client) ? 'account' : 'network',
  };
}

/**
 * Records one failed attempt. A single row carries both keys, so the two counters
 * stay consistent without a second write.
 */
export async function recordFailure({ ip, ua, username }) {
  await run(
    `INSERT INTO login_attempts (client_key, username_key, ip_hash)
     VALUES ($1, $2, $3)`,
    [
      clientKey(ip, ua),
      accountKey(username),
      // Consistent with the rest of the codebase: an address is stored only as a
      // one-way digest, so this table can never be turned into an IP log.
      key(`ip-only:${ip}`).slice(0, 16),
    ],
  );
  // Opportunistic cleanup keeps the table from growing without bound. Doing it
  // inline (rather than a cron) means there is nothing extra to configure, and the
  // window index bounds the scan.
  await run(`DELETE FROM login_attempts WHERE succeeded_at < now() - interval '2 days'`);
}

/**
 * Clears both scopes after a success, so one person's typo does not leave a
 * colleague's account throttled on a shared connection.
 */
export async function clearFailures({ ip, ua, username }) {
  await run(
    `DELETE FROM login_attempts WHERE client_key = $1 OR username_key = $2`,
    [clientKey(ip, ua), accountKey(username)],
  );
}

