import bcrypt from 'bcryptjs';
import { one, run } from '../_lib/db.js';
import { requireAuth, assertCsrf } from '../_lib/auth.js';
import { getLockout, recordFailure, clearFailures } from '../_lib/throttle.js';
import { recordLoginEvent } from '../_lib/audit.js';
import { withErrorHandling, send, jsonBody, clientIp, userAgent, str } from '../_lib/http.js';

/**
 * POST /api/auth/password
 *
 * Changes the signed-in user's own password. Deliberately narrow: it takes the
 * user id from the session token and never from the request body, so there is no
 * path here by which one account can set another's password. Managing other users'
 * credentials belongs to the not-yet-ported Users module and needs its own
 * authorisation checks.
 *
 * The current password is required even though the caller already holds a valid
 * session. That is what stops someone who walks up to an unlocked, already-signed-in
 * machine from taking the account over, and it is the same reason password fields
 * in settings are blocked outright by a schema trigger.
 *
 * Cost 12 on write, matching api/auth/login.js, so a password never lands at the
 * old cost no matter which endpoint set it.
 */
const BCRYPT_ROUNDS = 12;

/**
 * Minimum policy for a new password.
 *
 * Length is the only requirement that reliably buys something - composition rules
 * ("must contain a symbol") reliably push people toward `Password1!`, which is
 * worse than a long passphrase.
 *
 * The banned list catches the defaults this project itself ships, plus the handful of
 * passwords any guessing script tries first. Matching is by substring rather than
 * equality, because `admin12345678` and `admin1234` are exactly as guessable as
 * `admin123` while an exact-match list would wave all three through.
 */
const MIN_LENGTH = 12;
const BANNED = [
  'admin123',
  'password',
  'ecocollect',
  'qwerty',
  'letmein',
  'welcome',
  '123456789012',
];

export default withErrorHandling(async (req, res) => {
  const user = await requireAuth(req);
  assertCsrf(req);

  const body = await jsonBody(req);
  const current = str(body.current_password, {
    max: 200,
    required: true,
    field: 'Current password',
    trim: false,
  });
  const next = str(body.new_password, {
    max: 200,
    required: true,
    field: 'New password',
    trim: false,
  });

  if (next.length < MIN_LENGTH) {
    return send(res, 400, {
      error: `The new password must be at least ${MIN_LENGTH} characters long.`,
    });
  }
  if (BANNED.some((bad) => next.toLowerCase().includes(bad))) {
    return send(res, 400, { error: 'That password is too common. Choose something else.' });
  }
  if (next === current) {
    return send(res, 400, { error: 'The new password must be different from the current one.' });
  }

  const ip = clientIp(req);
  const ua = userAgent(req);

  // Requiring the current password makes this endpoint a password oracle for anyone
  // holding a stolen session, so it shares the login throttle. Without this, a
  // script could probe the current password indefinitely while the login path was
  // fully throttled.
  const lockout = await getLockout({ ip, ua, username: user.username });
  if (lockout.locked) {
    await recordLoginEvent({
      username: user.username,
      success: false,
      reason: 'password_change_throttled',
      ip,
      ua,
    });
    return send(res, 429, {
      error: `Too many failed attempts. Please wait ${lockout.seconds} seconds and try again.`,
      retryAfterSeconds: lockout.seconds,
    }, { 'Retry-After': String(lockout.seconds) });
  }

  const row = await one(`SELECT password FROM users WHERE id = $1`, [Number(user.sub)]);
  if (!row) return send(res, 404, { error: 'Account not found' });

  if (!(await bcrypt.compare(current, row.password))) {
    // Counted against the same counters as a failed login: guessing the current
    // password is guessing a password.
    await recordFailure({ ip, ua, username: user.username });
    await recordLoginEvent({
      username: user.username,
      success: false,
      reason: 'password_change_denied',
      ip,
      ua,
    });
    return send(res, 401, { error: 'The current password is incorrect.' });
  }

  const hashed = await bcrypt.hash(next, BCRYPT_ROUNDS);

  // Clearing must_change_password here is what completes the forced change that
  // the seeded admin account starts under.
  await run(
    `UPDATE users SET password = $1, must_change_password = false WHERE id = $2`,
    [hashed, Number(user.sub)],
  );

  // A successful change clears the counters, matching login: the user proved they
  // know the current password, so a run of typos before it should not linger.
  await clearFailures({ ip, ua, username: user.username });

  await recordLoginEvent({
    username: user.username,
    success: true,
    reason: 'password_changed',
    ip,
    ua,
  });

  return send(res, 200, { ok: true });
}, ['POST']);