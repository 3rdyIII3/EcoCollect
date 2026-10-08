import { newChallenge, issueToken, captchaCookie } from '../_lib/captcha.js';
import { withErrorHandling, send } from '../_lib/http.js';

/**
 * GET /api/auth/captcha
 *
 * Issues a fresh arithmetic challenge, sets the HMAC cookie, and returns only the
 * question. The answer is never sent to the browser, so the client has nothing to
 * read off the page - it has to actually be computed.
 *
 * A new challenge on every request means reloading always invalidates the previous
 * one, which is what lets a client treat it as single-use.
 */
export default withErrorHandling(async (req, res) => {
  const { question, answer } = newChallenge();

  res.setHeader('Set-Cookie', captchaCookie(issueToken(answer)));

  send(res, 200, { question });
}, ['GET', 'HEAD']);