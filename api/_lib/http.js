/** Shared request/response plumbing for the Vercel-style function handlers. */

/**
 * Baseline security headers on every API response.
 *
 * None of these substitute for CSRF or the auth checks - they stop a range of
 * smaller problems. X-Content-Type-Options stops a browser second-guessing a
 * response's type; X-Frame-Options stops any page framing the API response and
 * clicking-jacking a signed-in admin; Referrer-Policy keeps identifiers out of
 * the Referer header when a user follows a link away; HSTS tells the browser to
 * refuse plaintext for the rest of its life once an HTTPS response has arrived.
 *
 * HSTS is deliberately omitted in development, where the app is served over
 * http://localhost and a strict-transport header would make it unreachable.
 */
const isDev = process.env.NODE_ENV === 'development';

function securityHeaders() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (!isDev) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

export function send(res, status, payload, headers = {}) {
  if (res.headersSent) return;
  const all = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers,
  };
  res.writeHead?.(status, all);
  res.end(JSON.stringify(payload));
}

export function setCookies(res, cookies = []) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
}

export function fail(res, err) {
  const status = err?.statusCode || 500;
  // Don't leak internals in production; the local dev message helps debugging.
  const message =
    status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err?.message || 'Request failed';
  if (status >= 500) console.error('[api]', err);
  send(res, status, { error: message });
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  send(res, 405, { error: 'Method not allowed' });
}

/** Wraps a handler so thrown errors become clean JSON responses. */
export function withErrorHandling(handler, allowed = ['GET', 'POST']) {
  return async function wrapped(req, res) {
    try {
      const method = (req.method || 'GET').toUpperCase();
      if (!allowed.includes(method)) return methodNotAllowed(res, allowed);
      await handler(req, res, { method });
    } catch (err) {
      fail(res, err);
    }
  };
}

/** Parses a JSON body from a Vercel request (body already parsed, or a raw string). */
export async function jsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw Object.assign(new Error('Malformed JSON body'), { statusCode: 400 });
    }
  }
  return {};
}

/**
 * Query parameters, read from the URL rather than trusting `req.query`.
 *
 * Vercel populates `req.query` for its own runtime, but `vercel dev` and other
 * Node adapters do not always, and silently treating every filter as absent would
 * quietly return unfiltered data. Parsing `req.url` works everywhere.
 */
export function queryOf(req) {
  const out = { ...(req.query || {}) };
  try {
    const url = new URL(req.url || '', 'http://localhost');
    for (const [k, v] of url.searchParams) {
      if (out[k] === undefined) out[k] = v;
    }
  } catch {
    /* leave whatever req.query provided */
  }
  return out;
}

/**
 * The caller's address, for throttling and audit only.
 *
 * X-Forwarded-For is client-settable, so anyone can forge it and escape the
 * per-network throttle by varying it. The first hop is the one a proxy in front of
 * the app actually appended, so only that is trusted: Vercel sets it as
 * `<client>, <edge hops...>`, and anything a client put there lands further down
 * the list.
 *
 * This is a real limitation, not a solved problem - it is why the throttle also
 * counts per account, which a forged header cannot dodge.
 */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || '0.0.0.0';
}

export function userAgent(req) {
  return req.headers['user-agent'] || 'unknown';
}

/* ----------------------------------------------------------- validation */

export function str(value, { max = 255, trim = true, required = false, field = 'value' } = {}) {
  let v = value == null ? '' : String(value);
  if (trim) v = v.trim();
  if (required && !v) {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
  }
  if (v.length > max) {
    throw Object.assign(new Error(`${field} is too long`), { statusCode: 400 });
  }
  return v;
}

export function int(value, { field = 'value', min = null, max = null } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error(`${field} must be a number`), { statusCode: 400 });
  }
  if (min != null && n < min) {
    throw Object.assign(new Error(`${field} must be at least ${min}`), { statusCode: 400 });
  }
  if (max != null && n > max) {
    throw Object.assign(new Error(`${field} must be at most ${max}`), { statusCode: 400 });
  }
  return n;
}

export function num(value, { field = 'value', min = null, max = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error(`${field} must be a number`), { statusCode: 400 });
  }
  if (min != null && n < min) {
    throw Object.assign(new Error(`${field} must be at least ${min}`), { statusCode: 400 });
  }
  if (max != null && n > max) {
    throw Object.assign(new Error(`${field} must be at most ${max}`), { statusCode: 400 });
  }
  return n;
}

export function oneOf(value, allowed, { field = 'value', required = true } = {}) {
  const v = str(value, { field, required });
  if (!allowed.includes(v)) {
    throw Object.assign(new Error(`${field} must be one of: ${allowed.join(', ')}`), {
      statusCode: 400,
    });
  }
  return v;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

export function paging(query, { defaultPerPage = 10, maxPerPage = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.per_page, 10) || defaultPerPage;
  const perPage = Math.min(maxPerPage, Math.max(1, requested));
  return { page, perPage, offset: (page - 1) * perPage };
}
