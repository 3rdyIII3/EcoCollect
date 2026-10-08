import { all, scalar, localDateSql, localWeekdaySql } from './_lib/db.js';
import { requireAuth, isAdmin } from './_lib/auth.js';
import { withErrorHandling, send } from './_lib/http.js';

/**
 * GET /api/lookups
 *
 * Reference data every form needs (barangays, collectors, today's schedule) so the
 * UI can populate dropdowns in one call instead of one call per form.
 */
export default withErrorHandling(async (req, res) => {
  const user = await requireAuth(req);

  const barangays = await all(
    `SELECT id, name, zone, qr_code FROM barangays WHERE is_active = true ORDER BY name ASC`,
  );

  // A non-admin only needs themselves in the list; they cannot file for others.
  const collectors = isAdmin(user)
    ? await all(
        `SELECT col.id, col.route, u.full_name
           FROM collectors col
           JOIN users u ON u.id = col.user_id
          WHERE col.is_active = true AND u.is_active = true
          ORDER BY u.full_name ASC`,
      )
    : user.collector_id
      ? await all(
          `SELECT col.id, col.route, u.full_name
             FROM collectors col
             JOIN users u ON u.id = col.user_id
            WHERE col.id = $1`,
          [user.collector_id],
        )
      : [];

  const today = await scalar(`SELECT ${localDateSql()}::text AS v`);
  const weekday = await scalar(`SELECT ${localWeekdaySql()} AS v`);

  const todaySchedule = await all(
    `SELECT s.id, s.barangay_id, s.time_start, s.time_end, b.name AS barangay_name
       FROM schedules s
       JOIN barangays b ON b.id = s.barangay_id
      WHERE s.day_of_week = $1 AND s.is_active = true
      ORDER BY s.time_start ASC`,
    [weekday],
  );

  send(res, 200, {
    barangays,
    collectors,
    todaySchedule,
    today,
    weekday,
    me: {
      id: Number(user.sub),
      collector_id: user.collector_id != null ? Number(user.collector_id) : null,
    },
  });
}, ['GET']);
