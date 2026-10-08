import { all, one } from './_lib/db.js';
import { requireAuth, isStaff, isAdmin } from './_lib/auth.js';
import { withErrorHandling, send, int } from './_lib/http.js';

/**
 * GET /api/notifications
 *
 * Read-only for now. The shell polls `unread_count` for the bell badge and `limit`
 * for the dropdown preview. Listing is restricted to the same audience as the PHP
 * version: admins see broadcasts plus their own, supervisors only their own.
 */
export default withErrorHandling(async (req, res) => {
  const user = await requireAuth(req);

  // The bell is shown to admins and supervisors only.
  if (!isStaff(user)) return send(res, 200, { items: [], unread: 0 });

  const url = new URL(req.url || '', 'http://localhost');
  const unreadOnly = url.searchParams.get('unread_count') === '1';
  const limit = Math.min(50, Math.max(1, int(url.searchParams.get('limit') || 6, { field: 'limit', min: 1, max: 50 })));

  // recipient_id IS NULL is the "broadcast to admins" convention from the schema.
  const scope = isAdmin(user)
    ? '(n.recipient_id IS NULL OR n.recipient_id = $1)'
    : 'n.recipient_id = $1';

  const unread = Number(
    (await one(
      `SELECT COUNT(*)::int AS v
         FROM notifications n
        WHERE n.is_read = false AND n.is_archived = false AND ${scope}`,
      [user.sub],
    ))?.v || 0,
  );

  if (unreadOnly) return send(res, 200, { unread });

  const items = await all(
    `SELECT n.id, n.title, n.message, n.type, n.is_read, n.created_at,
            u.full_name AS sender_name
       FROM notifications n
       LEFT JOIN users u ON u.id = n.sender_id
      WHERE n.is_archived = false AND ${scope}
      ORDER BY n.created_at DESC
      LIMIT ${limit}`,
    [user.sub],
  );

  send(res, 200, { items, unread });
}, ['GET']);
