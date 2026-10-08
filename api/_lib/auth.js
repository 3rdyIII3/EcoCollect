import { SignJWT, jwtVerify } from 'jose';

const COOKIE = 'ecol_session';
const CSRF_COOKIE = 'ecol_csrf';
export const SESSION_COOKIE = COOKIE;
export const CSRF_COOKIE_NAME = CSRF_COOKIE;

/** 8 hours, matching a plausible municipal shift. */
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function secretKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw Object.assign(
      new Error('JWT_SECRET must be set and at least 32 characters long'),
      { statusCode: 500 },
    );
  }
  return new TextEncoder().encode(secret);
}

/* ------------------------------------------------------------------ cookies */

export function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serialiseCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) bits.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return bits.join('; ');
}

/**
 * Secure is on unless the app is explicitly running in development mode.
 *
 * This used to key off `NODE_ENV === 'production'`, which meant a deployment that
 * happened not to set NODE_ENV would quietly send session cookies without the
 * flag, allowing them over plaintext HTTP. Defaulting to secure and opting out
 * explicitly is the safer direction to fail: the local dev server sets
 * NODE_ENV=development itself, so nothing local is affected.
 */
const isDev = process.env.NODE_ENV === 'development';
const useSecure = !isDev;

export function sessionCookie(value, maxAge = SESSION_TTL_SECONDS) {
  return serialiseCookie(COOKIE, value, { maxAge, httpOnly: true, secure: useSecure });
}

export function clearSessionCookie() {
  return serialiseCookie(COOKIE, '', { maxAge: 0, httpOnly: true, secure: useSecure });
}

export function csrfCookie(value, maxAge = SESSION_TTL_SECONDS) {
  // Readable by JS on purpose: this is the double-submit half of the pair, the
  // client echoes it back in the X-CSRF-Token header.
  return serialiseCookie(CSRF_COOKIE, value, { maxAge, secure: useSecure });
}

export function clearCsrfCookie() {
  return serialiseCookie(CSRF_COOKIE, '', { maxAge: 0, secure: useSecure });
}

/* --------------------------------------------------------------------- JWT */

export async function signSession(user) {
  return new SignJWT({
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    collector_id: user.collector_id ?? null,
    route: user.route ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** Returns the payload, or null when the token is absent, tampered or expired. */
export async function readSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

export async function requireAuth(req) {
  const session = await readSession(req);
  if (!session) {
    throw Object.assign(new Error('Not authenticated'), { statusCode: 401 });
  }
  return session;
}

export function isAdmin(user) {
  return user?.role === 'admin';
}

export function isSupervisor(user) {
  return user?.role === 'supervisor';
}

export function isStaff(user) {
  return isAdmin(user) || isSupervisor(user);
}

/**
 * Double-submit CSRF check for state-changing requests.
 *
 * The session cookie is SameSite=Lax so modern browsers already withhold it from
 * cross-site POSTs; this is the belt-and-braces layer that also covers the login
 * POST, where no session cookie exists yet.
 */
export function assertCsrf(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const cookie = parseCookies(req)[CSRF_COOKIE];
  const header = req.headers['x-csrf-token'];
  if (!cookie || !header || cookie.length < 16 || header !== cookie) {
    throw Object.assign(new Error('Invalid CSRF token'), { statusCode: 403 });
  }
}