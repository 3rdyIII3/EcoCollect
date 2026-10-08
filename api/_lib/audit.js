import crypto from 'node:crypto';
import { run } from './db.js';

/**
 * Login audit trail.
 *
 * A throttled login endpoint still leaves no record of who tried what. For a
 * government system the question "who signed in, from where, when" usually has to
 * be answerable after the fact, so every attempt is written here - successes and
 * failures alike.
 *
 * The same privacy rule as the throttle applies: the client address is stored as a
 * truncated HMAC, never in the clear. The username is stored as typed because
 * without it the log cannot answer the question it exists for; it is truncated to
 * the column width on the way in.
 */
const RETENTION_DAYS = 90;

function ipHash(ip) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT_SECRET is not set'), { statusCode: 500 });
  return crypto.createHmac('sha256', secret).update(String(ip || '')).digest('base64url').slice(0, 16);
}

/**
 * @param username  as typed by the client, or '' when the request never got that far
 * @param success   did the credentials check out
 * @param reason    short machine-readable outcome, e.g. 'bad_credentials'
 * @param ip        raw address; hashed before storage
 * @param ua        user agent; truncated, since only the prefix identifies anything
 */
export async function recordLoginEvent({ username, success, reason = '', ip, ua = '' }) {
  await run(
    `INSERT INTO login_events (username, success, reason, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      String(username || '').slice(0, 50),
      Boolean(success),
      String(reason || '').slice(0, 40),
      ipHash(ip),
      String(ua || '').slice(0, 120),
    ],
  );

  // Inline cleanup, for the same reason as the throttle: no cron to configure.
  // Bounded by idx_login_events_recent, so this is an index seek for a table that
  // is mostly inside the window and nothing to delete.
  //
  // `username` is attacker-controlled and lands in the log verbatim. It is only ever
  // read back as a table cell, never rendered as HTML, and the insert is
  // parameterised - so it cannot inject SQL or markup here. It is capped at the
  // column width above so a long string cannot bloat a row.
  await run(
    `DELETE FROM login_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)],
  );
}