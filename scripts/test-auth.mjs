/**
 * Behavioural test for the auth primitives: CSRF double-submit, JWT signing,
 * cookie handling, throttle backoff, rehash detection, timezone guard and
 * validators. Runs without a database.
 */
process.env.JWT_SECRET ||= 'test-secret-that-is-definitely-long-enough-32chars';
// api/_lib/auth.js reads NODE_ENV at module load to decide on the Secure cookie
// flag, so this has to be set before the import below rather than inside a test.
process.env.NODE_ENV = 'development';

let pass = 0;
let fail = 0;
function check(label, got, want) {
  if (got === want) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

const auth = await import('../api/_lib/auth.js');
const http = await import('../api/_lib/http.js');
const db = await import('../api/_lib/db.js');
const throttle = await import('../api/_lib/throttle.js');
const captcha = await import('../api/_lib/captcha.js');

/* ---------------------------------------------------- security question */
/* The arithmetic challenge is a speed bump, so the properties worth pinning are that
   the answer is not derivable from the question, that verification is exact, and that
   an old token stops working. */
// NB: check() takes (label, got, want) and compares with ===, so boolean assertions
// pass true as `want` and put the diagnostic detail in a trailing comment - not in the
// third slot, which would be compared against.
const challenge = captcha.newChallenge();
check('question is a readable expression', /^(\d+ [+\u2212] \d+)$/.test(challenge.question), true);
check('answer is a small integer', /^\d{1,2}$/.test(challenge.answer), true);
check('answer is not stated in the question', !challenge.question.includes(challenge.answer), true);

// Subtraction never yields a negative answer, or a human would be asked for one.
let sawNegative = false;
for (let i = 0; i < 60; i += 1) {
  if (Number(captcha.newChallenge().answer) < 0) sawNegative = true;
}
check('answers are never negative', sawNegative, false);

const capToken = captcha.issueToken(challenge.answer);
check('correct answer verifies', captcha.verifyAnswer(capToken, challenge.answer), true);
check('leading/trailing space tolerated', captcha.verifyAnswer(capToken, ` ${challenge.answer} `), true);
check('wrong answer rejected', captcha.verifyAnswer(capToken, '99'), false);
check('empty answer rejected', captcha.verifyAnswer(capToken, ''), false);
check('missing token rejected', captcha.verifyAnswer(undefined, challenge.answer), false);
check('garbage token rejected', captcha.verifyAnswer('abc.def', challenge.answer), false);
check('non-numeric answer rejected', captcha.verifyAnswer(capToken, 'seven'), false);
check('over-long answer rejected', captcha.verifyAnswer(capToken, '12345678'), false);

// The signature covers the answer, so a token cannot be replayed with a different one.
const other = captcha.newChallenge();
check('token is answer-bound', captcha.verifyAnswer(capToken, other.answer) === (other.answer === challenge.answer), true);

// Expired: rewrite the issue time back past the TTL.
const stale = Math.floor(Date.now() / 1000) - (captcha.CAPTCHA_TTL_SECONDS + 60);
check('expired token rejected', captcha.verifyAnswer(capToken.replace(/^\d+\./, `${stale}.`), challenge.answer), false);

check('captcha cookie is httpOnly', captcha.captchaCookie('x').includes('HttpOnly'), true);
check('captcha cookie is SameSite=Lax', captcha.captchaCookie('x').includes('SameSite=Lax'), true);
check('clear cookie expires it', captcha.clearCaptchaCookie().includes('Max-Age=0'), true);

/* ------------------------------------------------------ throttle curve */
/* Escalating backoff rather than a flat lockout: a typo costs nothing, a script
   costs the full window, and a shared office IP cannot be locked out by a
   colleague's five mistakes. */
check('no failures -> no lock', throttle.lockSeconds(0), 0);
check('one failure -> no lock', throttle.lockSeconds(1), 0);
check('three failures -> no lock', throttle.lockSeconds(3), 0);
check('fourth failure -> 30s', throttle.lockSeconds(4), 30);
check('fifth failure -> 60s', throttle.lockSeconds(5), 60);
check('sixth failure -> 120s', throttle.lockSeconds(6), 120);
check('seventh failure -> 240s', throttle.lockSeconds(7), 240);
check('eighth failure -> 480s', throttle.lockSeconds(8), 480);
check('ninth failure -> capped at the window', throttle.lockSeconds(9), 900);
check('lockout grows monotonically', throttle.lockSeconds(10) >= throttle.lockSeconds(9), true);
check('lockout never exceeds the window', throttle.lockSeconds(50), 900);

/* --------------------------------------------------------------- CSRF */
const cookies = 'ecol_csrf=abcdefghijklmnop1234567890; ecol_session=whatever';
const parsed = auth.parseCookies({ headers: { cookie: cookies } });
check('cookie parsed', parsed.ecol_csrf, 'abcdefghijklmnop1234567890');

const goodReq = {
  method: 'POST',
  headers: { cookie: cookies, 'x-csrf-token': 'abcdefghijklmnop1234567890' },
};
let threw = false;
try {
  auth.assertCsrf(goodReq);
} catch {
  threw = true;
}
check('matching CSRF accepted', threw, false);

const badReq = { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': 'wrong' } };
threw = false;
try {
  auth.assertCsrf(badReq);
} catch (err) {
  threw = err.statusCode === 403;
}
check('mismatched CSRF rejected', threw, true);

threw = false;
try {
  auth.assertCsrf({ method: 'GET', headers: { cookie: cookies } });
} catch {
  threw = true;
}
check('GET skips CSRF', threw, false);

/* ---------------------------------------------------------------- JWT */
const tokenJwt = await auth.signSession({
  id: 7,
  username: 'admin',
  full_name: 'Test User',
  role: 'admin',
  collector_id: 3,
});
check('token is a JWT', tokenJwt.split('.').length, 3);

const payload = await auth.readSession({ headers: { cookie: `ecol_session=${tokenJwt}` } });
check('session round-trips', payload.sub, '7');
check('claims survive', payload.role, 'admin');
check('collector id survives', payload.collector_id, 3);

check('absent cookie -> null', await auth.readSession({ headers: {} }), null);
check(
  'tampered token rejected',
  await auth.readSession({ headers: { cookie: `ecol_session=${tokenJwt}x` } }),
  null,
);
check(
  'garbage cookie rejected',
  await auth.readSession({ headers: { cookie: 'ecol_session=not.a.jwt' } }),
  null,
);

/* ------------------------------------------------------- cookie flags */
const sessionCookie = auth.sessionCookie('abc');
check('session cookie HttpOnly', sessionCookie.includes('HttpOnly'), true);
check('session cookie SameSite=Lax', sessionCookie.includes('SameSite=Lax'), true);
check('session cookie has Path', sessionCookie.includes('Path=/'), true);
check('clear cookie expires', auth.clearSessionCookie().includes('Max-Age=0'), true);
check('csrf cookie NOT HttpOnly', auth.csrfCookie('abc').includes('HttpOnly'), false);

// This suite runs with NODE_ENV=development so cookies come out without Secure,
// matching how the dev server runs over http://localhost.
check('no Secure flag in development', sessionCookie.includes('Secure'), false);

/* ---------------------------------------------------- rehash detection */
/* A hash written at the old bcrypt cost must be detected from the hash string
   alone, so upgrading costs no migration step. */
const login = await import('../api/auth/login.js');
// The $2a$10$ prefix is the exact string PHP's password_hash() produced, which is
// what the migration carries over from the old app.
check('cost 10 hash needs rehash', login.needsRehash('$2a$10$Vqp1K6bgIasHSoX68wmWR.FaG9V4OfXmmO0vq3zKB7I5MAv9V3Q9C'), true);
check('2y prefix (PHP) needs rehash', login.needsRehash('$2y$10$Vqp1K6bgIasHSoX68wmWR.FaG9V4OfXmmO0vq3zKB7I5MAv9V3Q9C'), true);
check('cost 12 hash is current', login.needsRehash('$2b$12$Vqp1K6bgIasHSoX68wmWR.FaG9V4OfXmmO0vq3zKB7I5MAv9V3Q9C'), false);
check('2y prefix at cost 12 is current', login.needsRehash('$2y$12$Vqp1K6bgIasHSoX68wmWR.FaG9V4OfXmmO0vq3zKB7I5MAv9V3Q9C'), false);
check('cost 13 hash is left alone', login.needsRehash('$2b$13$Vqp1K6bgIasHSoX68wmWR.FaG9V4OfXmmO0vq3zKB7I5MAv9V3Q9C'), false);
check('unparseable hash is rehashed', login.needsRehash('not-a-hash'), true);
check('missing hash is rehashed', login.needsRehash(undefined), true);
// $2x$ is what PHP emits when it was configured to accept 8-bit input; it must not
// be mistaken for a current hash, because bcryptjs cannot safely verify those.
check('2x prefix (8-bit bcrypt) is rehashed', login.needsRehash('$2x$12$Vqp1K6bgIasHSoX68wmWR.FaG9V4OfXmmO0vq3zKB7I5MAv9V3Q9C'), true);

/* ----------------------------------------------------- timezone guard */
check('default tz is Manila', db.localTz(), 'Asia/Manila');
process.env.APP_TIMEZONE = "Asia/Manila'; DROP TABLE users; --";
threw = false;
try {
  db.localTz();
} catch {
  threw = true;
}
check('tz injection rejected', threw, true);
delete process.env.APP_TIMEZONE;

check('localDateSql shape', db.localDateSql(), "(now() AT TIME ZONE 'Asia/Manila')::date");
check('weekday sql shape', db.localWeekdaySql(), "to_char(now() AT TIME ZONE 'Asia/Manila', 'FMDay')");

/* ------------------------------------------------------ validators */
threw = false;
try {
  http.int('abc', { field: 'Weight' });
} catch (err) {
  threw = err.statusCode === 400;
}
check('int rejects non-numeric with 400', threw, true);

threw = false;
try {
  http.num('-5', { field: 'Weight', min: 0.1 });
} catch {
  threw = true;
}
check('num enforces minimum', threw, true);

threw = false;
try {
  http.oneOf('bogus', ['a', 'b'], { field: 'Type' });
} catch {
  threw = true;
}
check('oneOf rejects unknown', threw, true);

check('paging defaults page', http.paging({}).page, 1);
check('paging defaults perPage', http.paging({}).perPage, 10);
check('paging defaults offset', http.paging({}).offset, 0);
check('paging clamps per_page', http.paging({ per_page: '9999' }).perPage, 100);
check('paging computes offset', http.paging({ page: '3', per_page: '20' }).offset, 40);

/* -------------------------------------------------- query parsing */
check(
  'queryOf reads URL',
  http.queryOf({ url: '/api/collections?page=2&q=abc', query: {} }).page,
  '2',
);
check(
  'queryOf decodes values',
  http.queryOf({ url: '/x?q=a%20b', query: {} }).q,
  'a b',
);
check(
  'queryOf falls back to req.query',
  http.queryOf({ url: '/x', query: { a: '1' } }).a,
  '1',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
