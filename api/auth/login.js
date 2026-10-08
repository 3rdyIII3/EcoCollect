import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { one, run } from '../_lib/db.js';
import {
  signSession,
  sessionCookie,
  csrfCookie,
  assertCsrf,
  parseCookies,
} from '../_lib/auth.js';
import { getLockout, recordFailure, clearFailures } from '../_lib/throttle.js';
import { recordLoginEvent } from '../_lib/audit.js';
import {
  CAPTCHA_COOKIE,
  verifyAnswer,
  clearCaptchaCookie as clearCaptcha,
} from '../_lib/captcha.js';
import {
  withErrorHandling,
  send,
  jsonBody,
  clientIp,
  userAgent,
  str,
} from '../_lib/http.js';

/**
 * bcrypt cost for new hashes.
 *
 * The PHP original used 10. 12 is the current recommendation and makes an offline
 * attack against a stolen hash table roughly four times more expensive. Existing
 * hashes are upgraded on their owner's next successful login - see
 * needsRehash() - so this applies without asking anyone to reset a password.
 */
const BCRYPT_ROUNDS = 12;

/**
 * A real bcrypt hash of a random throwaway string, compared against when the
 * username does not exist, so that path costs roughly the same wall-clock time as
 * a genuine wrong-password check. Response timing then does not reveal which
 * usernames are registered. A malformed placeholder would compare instantly and
 * defeat the point.
 *
 * Built on first use rather than hardcoded, because the cost factor has to match
 * BCRYPT_ROUNDS. A pinned literal at the old cost of 10 would make an unknown
 * username visibly faster than a known one as soon as real hashes moved to 12,
 * reintroducing exactly the leak this exists to close.
 */
let timingEqualiserHash = null;
function timingEqualiser() {
  timingEqualiserHash ||= bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
  return timingEqualiserHash;
}

/**
 * POST /api/auth/login
 *
 * Order matters, and it is deliberate:
 *
 *   1. CSRF, so this cannot be driven from another site.
 *   2. Parse the body - the throttle keys on the username, and parsing a small JSON
 *      body costs nothing and touches no password hash.
 *   3. The lockout, so a throttled client never reaches bcrypt or the captcha.
 *   4. The captcha. It gates the database lookup and the password comparison, so an
 *      unattended script cannot even confirm a username exists. It does NOT count
 *      toward the throttle - see the note on that in _lib/captcha.js, since doing so
 *      would let anyone lock a user out by submitting wrong answers.
 *   5. The credential check.
 *
 * Every credential miss counts toward both throttle scopes and is written to the audit
 * log. A wrong captcha is audited too, but as its own reason.
 */
export default withErrorHandling(async (req, res) => {
  const ip = clientIp(req);
  const ua = userAgent(req);

  assertCsrf(req);

  const body = await jsonBody(req);
  // Not marked required: a missing field must still reach the throttle and the
  // timing-equalised bcrypt path below, or "you forgot the username" would be
  // distinguishable from a wrong password by response body and latency.
  const username = str(body.username, { max: 50, field: 'Username' });
  const password = str(body.password, { max: 200, field: 'Password', trim: false });

  const lockout = await getLockout({ ip, ua, username });
  if (lockout.locked) {
    await recordLoginEvent({ username, success: false, reason: 'throttled', ip, ua });
    return send(res, 429, {
      error: `Too many failed login attempts. Please wait ${lockout.seconds} seconds and try again.`,
      retryAfterSeconds: lockout.seconds,
    }, { 'Retry-After': String(lockout.seconds) });
  }

  // Verified before the database lookup, so a wrong answer never reaches a query or a
  // password hash. Clearing the cookie forces a fresh challenge on the retry.
  if (!verifyAnswer(parseCookies(req)[CAPTCHA_COOKIE], body.captcha)) {
    await recordLoginEvent({ username, success: false, reason: 'bad_captcha', ip, ua });
    res.setHeader('Set-Cookie', clearCaptcha());
    return send(res, 400, {
      error: 'Incorrect answer to the security question. Please try again.',
    });
  }

  const user = await one(
    `SELECT id, username, password, full_name, role, is_active, must_change_password
       FROM users
      WHERE lower(username) = lower($1)`,
    [username],
  );

  // Same response and comparable timing whether the user exists, is inactive, or
  // the password is wrong, so this cannot be used to enumerate accounts.
  const hash = user?.password || timingEqualiser();
  const passwordOk = await bcrypt.compare(password, hash);

  if (!user || !passwordOk || !user.is_active) {
    await recordFailure({ ip, ua, username });
    await recordLoginEvent({ username, success: false, reason: 'bad_credentials', ip, ua });
    const error = user && !user.is_active
      ? 'This account has been deactivated. Please contact an administrator.'
      : 'Invalid username or password.';
    // Burned along with the failed attempt, so the retry needs a fresh challenge.
    res.setHeader('Set-Cookie', clearCaptcha());
    return send(res, 401, { error });
  }

  // A collector's route rides along in the token so the UI can label collections
  // without a second round trip, mirroring the old $_SESSION['collector_id'].
  const collector = await one(
    `SELECT id, route FROM collectors WHERE user_id = $1`,
    [user.id],
  );

  // Opportunistically upgrade a hash written at the old cost. Failing here would
  // only mean the upgrade retries on the next login, so it must not break a
  // successful sign-in.
  //
  // A forced change is left in place even when the hash was upgraded: the seeded
  // password is published in the README, so re-hashing it does not make it secret.
  if (needsRehash(user.password)) {
    try {
      const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await run(`UPDATE users SET password = $1 WHERE id = $2`, [upgraded, user.id]);
    } catch (err) {
      console.error('[api] password rehash failed', err);
    }
  }

  const token = await signSession({
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    collector_id: collector?.id ?? null,
    route: collector?.route ?? null,
  });

  await clearFailures({ ip, ua, username });
  await recordLoginEvent({ username, success: true, reason: 'ok', ip, ua });

  // A fresh CSRF token per login, so the value minted on the (public) login page
  // cannot be reused once a session exists.
  const csrf = crypto.randomBytes(24).toString('base64url');

  res.setHeader('Set-Cookie', [sessionCookie(token), csrfCookie(csrf), clearCaptcha()]);

  return send(res, 200, {
    user: {
      id: Number(user.id),
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      // True while a published default password is still in use. The client routes
      // to the change-password screen and shows nothing else until it is cleared.
      must_change_password: Boolean(user.must_change_password),
    },
    csrfToken: csrf,
  });
}, ['POST']);

/**
 * True when a stored hash was made at a lower cost than we now use.
 *
 * The cost is read out of the hash itself ($2a$12$...), which is why a hash from
 * the PHP original is detected without any migration step. A hash we cannot parse
 * is treated as needing a rehash rather than skipped.
 */
export function needsRehash(storedHash) {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(String(storedHash || ''));
  if (!match) return true;
  return Number.parseInt(match[1], 10) < BCRYPT_ROUNDS;
}