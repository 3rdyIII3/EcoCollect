/**
 * Thin fetch wrapper.
 *
 * Centralises three things every call needs: JSON in/out, the CSRF header for
 * mutations, and turning a non-2xx response into a thrown Error so callers can use
 * try/catch instead of inspecting .ok everywhere.
 */

let csrfToken = null;

export function setCsrfToken(token) {
  if (token) csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      // Session + CSRF cookies must ride along; without this the API is anonymous.
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Network error. Please check your connection.', 0);
  }

  // A hard redirect to login means the session expired mid-session.
  if (res.status === 401) {
    const data = await safeJson(res);
    throw new ApiError(data?.error || 'Your session has expired. Please sign in again.', 401);
  }

  if (!res.ok) {
    const data = await safeJson(res);
    const err = new ApiError(data?.error || `Request failed (${res.status})`, res.status);
    // The server sends how long a throttled client must wait. Surfacing it lets the
    // login form say "wait 60 seconds" instead of a generic failure, which matters
    // because the whole point of the escalating backoff is that the wait is short
    // for a typo and long for a script.
    const retryAfter = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSeconds = retryAfter;
    throw err;
  }

  return safeJson(res);
}

async function safeJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('POST', path, body ?? {}),
  del: (path, body) => request('POST', path, body ?? {}),
};

/** Appends a query string, dropping empty values so URLs stay tidy. */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const out = sp.toString();
  return out ? `?${out}` : '';
}
