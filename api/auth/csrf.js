import crypto from 'node:crypto';
import { csrfCookie } from '../_lib/auth.js';
import { withErrorHandling, send } from '../_lib/http.js';

/**
 * GET /api/auth/csrf
 *
 * Mints the double-submit CSRF pair for a client that has no session yet. The value
 * is returned in the body and also set as a JS-readable cookie; the login POST then
 * echoes it back in the X-CSRF-Token header.
 */
export default withErrorHandling(async (req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  res.setHeader('Set-Cookie', csrfCookie(token));

  send(res, 200, { csrfToken: token });
}, ['GET']);
