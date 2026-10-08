import { all, one, run } from './_lib/db.js';
import { requireAuth, isStaff, isAdmin, assertCsrf } from './_lib/auth.js';
import { withErrorHandling, send, jsonBody, int, oneOf } from './_lib/http.js';

/**
 * /api/notifications
 *   GET  ?unread_count=1 | ?limit=N | ?archived=1   list
 *   POST action = mark_read | mark_all_read | archive | unarchive | delete
 *
 * Listing is restricted to the same audience as the PHP version: admins see broadcasts
 * plus their own, supervisors only their own. The same scope filter is applied to every
 * mutation, so a supervisor cannot archive or delete a broadcast addressed to an admin
 * by guessing its id - the WHERE clause, not the UI, is what decides.
 */
export default withErrorHandling(async (req, res) => {
  const user = await requireAuth(req);
  const method = (req.method || 'GET').toUpperCase();

  // The bell is shown to admins and supervisors only.
  if (!isStaff(user)) return send(res, 200, { items: [], unread: 0 });

  // recipient_id IS NULL is the "broadcast to admins" convention from the schema.
  const scope = isAdmin(user)
    ? '(n.recipient_id IS NULL OR n.recipient_id = $1)'
    : 'n.recipient_id = $1';

  /* --------------------------------------------------------------- mutations */
  if (method === 'POST') {
    assertCsrf(req);
    const body = await jsonBody(req);
    const action = oneOf(
      body.action,
      ['mark_read', 'mark_all_read', 'archive', 'unarchive', 'delete'],
      { field: 'action' },
    );

    if (action === 'mark_all_read') {
      // No id needed: the scope clause is what keeps this to what the caller may see.
      await run(
        `UPDATE notifications SET is_read = true WHERE is_read = false AND is_archived = false AND ${scope}`,
        [user.sub],
      );
      return send(res, 200, { ok: true });
    }

    const id = int(body.id, { field: 'id', min: 1 });

    if (action === 'delete') {
      // A broadcast is addressed to every admin, so deleting one is an admin action
      // even though supervisors can see it in their list.
      if (isAdmin(user)) {
        await run(
          `DELETE FROM notifications WHERE id = $1 AND (recipient_id IS NULL OR recipient_id = $2)`,
          [id, user.sub],
        );
      } else {
        await run(`DELETE FROM notifications WHERE id = $1 AND ${scope}`, [id, user.sub]);
      }
      return send(res, 200, { ok: true });
    }

    const isArchived = action === 'archive';
    await run(
      `UPDATE notifications SET is_archived = $1, is_read = $2
        WHERE id = $3 AND ${scope}`,
      [isArchived, true, id, user.sub],
    );
    return send(res, 200, { ok: true, is_archived: isArchived, is_read: true });
  }

  /* ------------------------------------------------------------------- list */
  const url = new URL(req.url || '', 'http://localhost');
  const unreadOnly = url.searchParams.get('unread_count') === '1';
  const limit = Math.min(50, Math.max(1, int(url.searchParams.get('limit') || 6, { field: 'limit', min: 1, max: 50 })));
  const showArchived = url.searchParams.get('archived') === '1';

  const unread = Number(
    (await one(
      `SELECT COUNT(*)::int AS v
         FROM notifications n
        WHERE n.is_read = false AND n.is_archived = false AND ${scope}`,
      [user.sub],
    ))?.v || 0,
  );

  if (unreadOnly) return send(res, 200, { unread });

  // archived=1 shows the archive and hides the live list, rather than mixing the two -
  // an unread badge next to a row you already filed away is confusing.
  const archivedFilter = showArchived ? 'n.is_archived = true' : 'n.is_archived = false';

  const items = await all(
    `SELECT n.id, n.title, n.message, n.type, n.is_read, n.is_archived, n.created_at,
            u.full_name AS sender_name
       FROM notifications n
       LEFT JOIN users u ON u.id = n.sender_id
      WHERE ${archivedFilter} AND ${scope}
      ORDER BY n.created_at DESC
      LIMIT ${limit}`,
    [user.sub],
  );

  send(res, 200, { items, unread });
}, ['GET', 'POST']);
