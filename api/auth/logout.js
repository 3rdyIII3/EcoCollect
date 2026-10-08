import { clearSessionCookie, clearCsrfCookie } from '../_lib/auth.js';
import { clearCaptchaCookie } from '../_lib/captcha.js';
import { withErrorHandling, send } from '../_lib/http.js';

/**
 * POST /api/auth/logout
 *
 * Stateless tokens cannot be revoked server side, so logout clears the cookies and
 * the browser discards the token. With an 8h expiry a copied token stays valid
 * until then; that is the documented trade-off of the stateless approach.
 */
export default withErrorHandling(async (req, res) => {
  res.setHeader('Set-Cookie', [clearSessionCookie(), clearCsrfCookie(), clearCaptchaCookie()]);
  send(res, 200, { ok: true });
}, ['POST']);