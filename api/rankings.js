import { all, localDateSql } from './_lib/db.js';
import { requireAuth, isStaff, assertCsrf } from './_lib/auth.js';
import { withErrorHandling, send, jsonBody, oneOf } from './_lib/http.js';

/**
 * /api/rankings
 *   GET  ?period=week|month|quarter|year   per-capita barangay ranking
 *   POST action=waste_by_type             the same window sliced by waste stream
 *
 * Staff-only. A collector ranking whole barangays would be reporting on colleagues'
 * performance, so this is gated exactly like the dashboard's charts.
 *
 * This module is the payoff for the MySQL -> Postgres port in one place: the original
 * ranked with FIELD() and a bare division, neither of which exists in Postgres. The
 * weekday ordering helper in db.js handles FIELD(); the division needed NULLIF, and
 * that is the part worth reading.
 */

const PERIOD_DAYS = { week: 7, month: 30, quarter: 90, year: 365 };

/**
 * Per-capita ranking over a rolling window.
 *
 * $1 is the window length in days; the start date is derived from the app timezone so
 * "this month" means the same thing it does on the dashboard.
 *
 * The division is guarded with NULLIF(b.population, 0). Two of the seeded barangays
 * have no population recorded, and a bare `/` by zero is a hard error in Postgres that
 * would fail the whole query rather than just that row. NULLIF turns it into NULL, so
 * an unpopulated barangay lands at the bottom with no rate instead of taking the page
 * down. This is the single most likely thing to break if someone "simplifies" it.
 *
 * The date filter lives in the JOIN, not the WHERE: moving it to WHERE would turn the
 * LEFT JOIN into an inner one and silently drop every barangay with no collections in
 * the window, which is most of them on a short period.
 *
 * RANK() rather than ROW_NUMBER() so barangays on identical per-capita figures genuinely
 * tie, instead of implying an order the data does not support.
 */
const RANKING_SQL = `
  SELECT b.id,
         b.name,
         b.population,
         COALESCE(SUM(c.weight_kg), 0)::numeric(12,2) AS total_kg,
         COUNT(c.id)::int                              AS collections,
         COALESCE(SUM(c.bags_count), 0)::int           AS bags,
         ROUND(
           COALESCE(SUM(c.weight_kg), 0)::numeric / NULLIF(b.population::numeric, 0),
           3
         )                                             AS kg_per_capita
    FROM barangays b
    LEFT JOIN collections c
           ON c.barangay_id = b.id
          AND c.collection_date >= (${localDateSql()} - $1::int)
   WHERE b.is_active = true
   GROUP BY b.id, b.name, b.population
   ORDER BY kg_per_capita DESC NULLS LAST, b.name ASC
`;

/**
 * The same window broken down by waste stream.
 *
 * Inner join here on purpose: with no collections there is no waste type to report, so
 * a barangay contributes no rows rather than a row of zeroes. Totals agree with the
 * headline table because both read the same window.
 */
const BY_TYPE_SQL = `
  SELECT b.id,
         b.name,
         b.population,
         c.waste_type,
         COALESCE(SUM(c.weight_kg), 0)::numeric(12,2) AS total_kg,
         ROUND(
           COALESCE(SUM(c.weight_kg), 0)::numeric / NULLIF(b.population::numeric, 0),
           3
         )                                             AS kg_per_capita
    FROM barangays b
    JOIN collections c
      ON c.barangay_id = b.id
     AND c.collection_date >= (${localDateSql()} - $1::int)
   WHERE b.is_active = true
   GROUP BY b.id, b.name, b.population, c.waste_type
   ORDER BY kg_per_capita DESC NULLS LAST, b.name ASC, c.waste_type ASC
`;

export default withErrorHandling(
  async (req, res) => {
    const user = await requireAuth(req);
    const method = (req.method || 'GET').toUpperCase();

    if (!isStaff(user)) {
      return send(res, 403, { error: 'Supervisor or administrator access required' });
    }

    const query = new URL(req.url || '', 'http://localhost').searchParams;
    const period = oneOf(query.get('period') || 'month', Object.keys(PERIOD_DAYS), {
      field: 'period',
    });
    const days = PERIOD_DAYS[period];

    if (method === 'POST') {
      assertCsrf(req);
      const body = await jsonBody(req);
      const action = oneOf(body.action, ['waste_by_type'], { field: 'action' });
      const rows = await all(BY_TYPE_SQL, [days]);
      return send(res, 200, { rows, period, days, view: action });
    }

    const rows = await all(RANKING_SQL, [days]);
    return send(res, 200, { rows, period, days });
  },
  ['GET', 'POST'],
);