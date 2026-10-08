import crypto from 'node:crypto';

/**
 * A basic arithmetic captcha for the login page.
 *
 * Chosen over a distorted image because this one is genuinely usable by a human on a
 * phone in poor light, which is how most collectors will actually sign in. It is also
 * trivial to render and to verify without an image pipeline.
 *
 * What it is: a speed bump. It stops an unattended script hammering the endpoint, and
 * nothing more. The login throttle is what limits password guessing - see the note on
 * counting failures below, because the temptation is to fold these two together and
 * doing so would create a denial-of-service hole.
 */
export const CAPTCHA_TTL_SECONDS = 300; // 5 minutes

export const CAPTCHA_COOKIE = 'ecol_captcha';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw Object.assign(new Error('JWT_SECRET must be set and at least 32 characters long'), {
      statusCode: 500,
    });
  }
  return s;
}

/**
 * Builds a fresh question and its answer.
 *
 * Addition or subtraction of two small operands, and subtraction is always the larger
 * value first so the answer is never negative. Kept to one-digit operands and a
 * 1-18 answer range: large enough that the answer is not guessable from the visible
 * operands alone in a couple of tries, small enough to type without error.
 *
 * The answer never leaves this module. Only the question goes to the browser.
 */
export function newChallenge() {
  const a = crypto.randomInt(2, 10);
  const b = crypto.randomInt(2, 10);

  // randomInt rather than random() * 2 to avoid modulo bias on the coin flip.
  const add = crypto.randomInt(0, 2) === 0;

  if (add) {
    return { question: `${a} + ${b}`, answer: String(a + b) };
  }
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return { question: `${high} − ${low}`, answer: String(high - low) };
}

/**
 * Binds an answer to its issue time so the cookie cannot be replayed indefinitely.
 *
 * The signature travels in an httpOnly cookie rather than server-side state, so a cold
 * start needs no storage - the same trade the session token already makes.
 */
export function issueToken(answer) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', secret()).update(`${answer}.${issuedAt}`).digest('base64url');
  return `${issuedAt}.${mac}`;
}

/** Constant-time check of a submitted answer against the token in the cookie. */
export function verifyAnswer(token, answer) {
  if (typeof token !== 'string' || !token) return false;

  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const issuedAt = Number.parseInt(token.slice(0, dot), 10);
  const mac = token.slice(dot + 1);
  if (!Number.isFinite(issuedAt)) return false;

  const age = Math.floor(Date.now() / 1000) - issuedAt;
  if (age > CAPTCHA_TTL_SECONDS) return false;
  if (age < -30) return false; // clock skew guard

  const guess = String(answer ?? '').trim();
  if (!/^\d{1,3}$/.test(guess)) return false;

  const expected = crypto
    .createHmac('sha256', secret())
    .update(`${guess}.${issuedAt}`)
    .digest('base64url');

  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function captchaCookie(token) {
  const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
  return [
    `${CAPTCHA_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${CAPTCHA_TTL_SECONDS}`,
    'HttpOnly',
    `SameSite=Lax${secure}`,
  ].join('; ');
}

export function clearCaptchaCookie() {
  return `${CAPTCHA_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/**
 * Why a wrong captcha does NOT count toward the login throttle.
 *
 * The obvious design is to treat a bad captcha like a bad password. That is a denial of
 * service: anyone who knows a username could lock a real user out for the escalating
 * backoff window by submitting wrong answers on purpose, with no password knowledge at
 * all. The throttle is keyed partly on username precisely so guessing is capped - it
 * must not become a lever for locking people out.
 *
 * So the captcha is purely a speed bump and guessing it costs nothing. That is sound
 * because solving the captcha gets an attacker no further: they still face the
 * per-account throttle on the credentials, which a forged header cannot evade.
 */