import { readSession } from '../_lib/auth.js';
import { one } from '../_lib/db.js';
import { withErrorHandling, send } from '../_lib/http.js';

/**
 * GET /api/auth/me
 *
 * Returns the signed-in user. The token is re-checked against the database on
 * every call so that deactivating or deleting a user takes effect immediately,
 * rather than lingering until the token expires.
 */
export default withErrorHandling(async (req, res) => {
  const session = await readSession(req);
  if (!session) return send(res, 200, { user: null });

  const user = await one(
    `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.must_change_password,
            c.id AS collector_id, c.route
       FROM users u
       LEFT JOIN collectors c ON c.user_id = u.id
      WHERE u.id = $1`,
    [Number(session.sub)],
  );

  if (!user || !user.is_active) return send(res, 200, { user: null });

  return send(res, 200, {
    user: {
      id: Number(user.id),
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      collector_id: user.collector_id != null ? Number(user.collector_id) : null,
      route: user.route ?? null,
      must_change_password: Boolean(user.must_change_password),
    },
  });
}, ['GET']);
