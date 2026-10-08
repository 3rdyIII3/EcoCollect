import { all, scalar, localDateSql, localWeekdaySql, localMonthStartSql } from './_lib/db.js';
import { requireAuth, isStaff } from './_lib/auth.js';
import { withErrorHandling, send, oneOf, int, queryOf } from './_lib/http.js';

/**
 * GET /api/dashboard
 *
 * Serves the KPI tiles, the recent-collections table and every chart series in one
 * response - the PHP version issued eight separate queries for the same screen.
 */

const PERIOD_DAYS = { week: 7, month: 30, year: 365 };

/**
 * Builds a WHERE fragment plus its parameter array.
 *
 * Placeholder numbers are assigned by the `push` helper as the fragment is built, so
 * they always line up with the params array no matter which optional filters apply.
 * Collector scoping happens here, in SQL - never by filtering results in the UI.
 */
function buildScope({ staff, collectorId, days, barangayId }) {
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const daysPh = push(String(days));
  const collectorPh = staff ? null : push(collectorId);
  const barangayPh = barangayId ? push(barangayId) : null;

  const parts = [`c.collection_date >= (${localDateSql()} - ${daysPh}::int)`];
  if (collectorPh) parts.push(`c.collector_id = ${collectorPh}`);
  if (barangayPh) parts.push(`c.barangay_id = ${barangayPh}`);

  return { text: parts.join(' AND '), params, hasBarangay: Boolean(barangayPh) };
}

export default withErrorHandling(async (req, res) => {
  const user = await requireAuth(req);
  const staff = isStaff(user);
  const query = queryOf(req);

  const period = oneOf(query?.period || 'month', Object.keys(PERIOD_DAYS));
  const days = PERIOD_DAYS[period];
  const barangayId = staff && query?.barangay_id
    ? int(query.barangay_id, { field: 'barangay_id', min: 1 })
    : 0;

  const scope = buildScope({
    staff,
    collectorId: user.collector_id,
    days,
    barangayId,
  });

  const one = async (text, params) => Number((await scalar(text, params)) || 0);

  const today = await scalar(`SELECT ${localDateSql()}::text AS v`);
  const weekday = await scalar(`SELECT ${localWeekdaySql()} AS v`);
  const monthStart = await scalar(`SELECT ${localMonthStartSql()}::text AS v`);

  // Written as explicit staff / collector branches rather than appending an optional
  // "AND collector_id = $N" fragment. Concatenating a clause that reuses an existing
  // placeholder number silently binds one value to two different columns.
  const stats = staff
    ? {
        todayKg: await one(
          `SELECT COALESCE(SUM(c.weight_kg), 0) AS v FROM collections c WHERE c.collection_date = $1`,
          [today],
        ),
        monthKg: await one(
          `SELECT COALESCE(SUM(c.weight_kg), 0) AS v FROM collections c WHERE c.collection_date >= $1`,
          [monthStart],
        ),
        completedToday: await one(
          `SELECT COUNT(*)::int AS v FROM collections
            WHERE collection_date = $1 AND status = 'completed'`,
          [today],
        ),
        scheduledToday: await one(
          `SELECT COUNT(*)::int AS v FROM schedules WHERE day_of_week = $1 AND is_active = true`,
          [weekday],
        ),
        // Only meaningful for staff; null tells the UI to hide the tile.
        pendingReports: await one(
          `SELECT COUNT(*)::int AS v FROM dumping_reports WHERE status = 'pending'`,
        ),
      }
    : {
        todayKg: await one(
          `SELECT COALESCE(SUM(c.weight_kg), 0) AS v FROM collections c
            WHERE c.collection_date = $1 AND c.collector_id = $2`,
          [today, user.collector_id],
        ),
        monthKg: await one(
          `SELECT COALESCE(SUM(c.weight_kg), 0) AS v FROM collections c
            WHERE c.collection_date >= $1 AND c.collector_id = $2`,
          [monthStart, user.collector_id],
        ),
        completedToday: await one(
          `SELECT COUNT(*)::int AS v FROM collections
            WHERE collection_date = $1 AND status = 'completed' AND collector_id = $2`,
          [today, user.collector_id],
        ),
        scheduledToday: await one(
          `SELECT COUNT(*)::int AS v FROM schedules
            WHERE day_of_week = $1 AND is_active = true AND collector_id = $2`,
          [weekday, user.collector_id],
        ),
        pendingReports: null,
      };

  const recent = await all(
    `SELECT c.id, c.weight_kg, c.waste_type, c.collection_date, c.collection_time,
            c.status, c.created_at, b.name AS barangay_name, u.full_name AS collector_name
       FROM collections c
       JOIN barangays b ON b.id = c.barangay_id
       JOIN collectors col ON col.id = c.collector_id
       JOIN users u ON u.id = col.user_id
      WHERE ${scope.text}
      ORDER BY c.created_at DESC
      LIMIT 10`,
    scope.params,
  );

  // Charts and rankings were staff-only in the original UI; a collector's totals are
  // already scoped above, so hiding the series is a presentation choice, not the
  // access control.
  let series = null;
  if (staff) {
    const wasteByType = await all(
      `SELECT c.waste_type, SUM(c.weight_kg) AS total
         FROM collections c
        WHERE ${scope.text}
        GROUP BY c.waste_type
        ORDER BY total DESC`,
      scope.params,
    );

    const dailyTrend = await all(
      `SELECT c.collection_date, SUM(c.weight_kg) AS total
         FROM collections c
        WHERE ${scope.text}
        GROUP BY c.collection_date
        ORDER BY c.collection_date ASC`,
      scope.params,
    );

    const monthlyTrend = await all(
      `SELECT to_char(c.collection_date, 'YYYY-MM') AS month, SUM(c.weight_kg) AS total
         FROM collections c
        WHERE c.collection_date >= (${localDateSql()} - $1::int)
          ${barangayId ? 'AND c.barangay_id = $2' : ''}
        GROUP BY month
        ORDER BY month ASC`,
      barangayId ? [String(days), barangayId] : [String(days)],
    );

    // LEFT JOIN keeps barangays with no collections in the window, matching MySQL.
    const joinScope = buildScope({
      staff,
      collectorId: user.collector_id,
      days,
      barangayId: 0,
    });
    const wasteByBarangay = await all(
      `SELECT b.id, b.name, COALESCE(SUM(c.weight_kg), 0) AS total_weight,
              COUNT(c.id)::int AS collection_count
         FROM barangays b
         LEFT JOIN collections c
           ON c.barangay_id = b.id AND ${joinScope.text}
        WHERE b.is_active = true
        GROUP BY b.id, b.name
        ORDER BY total_weight DESC`,
      joinScope.params,
    );

    const wasteByCollector = await all(
      `SELECT u.full_name, COUNT(c.id)::int AS trips,
              COALESCE(SUM(c.weight_kg), 0) AS total_weight
         FROM collectors col
         JOIN users u ON u.id = col.user_id
         LEFT JOIN collections c
           ON c.collector_id = col.id AND ${joinScope.text}
        GROUP BY col.id, u.full_name
        ORDER BY total_weight DESC`,
      joinScope.params,
    );

    const totalWeight = await one(
      `SELECT COALESCE(SUM(c.weight_kg), 0) AS v FROM collections c WHERE ${scope.text}`,
      scope.params,
    );
    const completed = await one(
      `SELECT COUNT(*)::int AS v FROM collections c WHERE ${scope.text}`,
      scope.params,
    );

    /**
     * Expected collection slots in the window.
     *
     * The MySQL version counted *schedule rows* whose weekday appeared in the window,
     * then divided completed collections by that. Those are different units - 54
     * collections over 3 schedule rows produced a 1800% "completion rate". This expands
     * each schedule across the actual days in the window that match its weekday, which
     * is what "how many collections should have happened" actually means.
     */
    const windowStart = await scalar(
      `SELECT (${localDateSql()} - $1::int)::text AS v`,
      [String(days)],
    );
    const scheduled = await one(
      `SELECT COALESCE(SUM(slots), 0)::int AS v
         FROM schedules s
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::int AS slots
             FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
            WHERE to_char(d.day, 'FMDay') = s.day_of_week
         ) l
        WHERE s.is_active = true`,
      [windowStart, today],
    );

    series = {
      wasteByType,
      dailyTrend,
      monthlyTrend,
      wasteByBarangay,
      wasteByCollector,
      totals: {
        totalWeight,
        completed,
        scheduled,
        // Clamped: collecting more often than scheduled is not a >100% completion rate,
        // and an unbounded number on a tile looks like a bug.
        completionRate:
          scheduled > 0 ? Math.min(100, Math.round((completed / scheduled) * 100)) : 0,
        avgPerCollection: completed > 0 ? totalWeight / completed : 0,
      },
    };
  }

  send(res, 200, {
    role: user.role,
    period,
    stats,
    recent,
    series,
    today,
    weekday,
  });
}, ['GET']);
