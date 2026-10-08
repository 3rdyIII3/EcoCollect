import { all, one, run } from './_lib/db.js';
import { requireAuth, isStaff, assertCsrf } from './_lib/auth.js';
import {
  withErrorHandling,
  send,
  jsonBody,
  queryOf,
  oneOf,
  num,
  int,
  str,
  paging,
} from './_lib/http.js';

/**
 * /api/collections
 *   GET    list (scoped: collectors see only their own rows)
 *   POST   action = create | update | delete
 */

const WASTE_TYPES = ['Organic', 'Plastic', 'Residual', 'Recyclable', 'Hazardous', 'Mixed'];
const STATUSES = ['completed', 'partial', 'missed'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function dateRe(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export default withErrorHandling(
  async (req, res) => {
    const user = await requireAuth(req);
    const staff = isStaff(user);
    const method = (req.method || 'GET').toUpperCase();

    /* ------------------------------------------------------------ list */
    if (method === 'GET') {
      const query = queryOf(req);
      const { page, perPage, offset } = paging(query);

      const where = [];
      const params = [];
      const push = (v) => {
        params.push(v);
        return `$${params.length}`;
      };

      // Collector scoping is the security boundary here, not a UI convenience.
      if (!staff) where.push(`c.collector_id = ${push(user.collector_id)}`);

      const search = str(query.q, { max: 100 });
      if (search) {
        const ph = push(`%${search.replace(/[%_]/g, (m) => `\\${m}`)}%`);
        where.push(`(b.name ILIKE ${ph} OR u.full_name ILIKE ${ph})`);
      }
      if (query.barangay_id) where.push(`c.barangay_id = ${push(int(query.barangay_id, { field: 'barangay_id', min: 1 }))}`);
      if (query.waste_type) where.push(`c.waste_type = ${push(oneOf(query.waste_type, WASTE_TYPES, { field: 'waste_type' }))}`);
      if (query.status) where.push(`c.status = ${push(oneOf(query.status, STATUSES, { field: 'status' }))}`);
      if (dateRe(query.date_from)) where.push(`c.collection_date >= ${push(query.date_from)}`);
      if (dateRe(query.date_to)) where.push(`c.collection_date <= ${push(query.date_to)}`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = Number(
        (
          await one(
            `SELECT COUNT(*)::int AS v
               FROM collections c
               JOIN barangays b ON b.id = c.barangay_id
               JOIN collectors col ON col.id = c.collector_id
               JOIN users u ON u.id = col.user_id
               ${whereSql}`,
            params,
          )
        )?.v || 0,
      );

      const rows = await all(
        `SELECT c.id, c.barangay_id, c.collector_id, c.weight_kg, c.waste_type,
                c.bags_count, c.collection_date, c.collection_time, c.status,
                c.notes, c.photo, c.created_at,
                b.name AS barangay_name, u.full_name AS collector_name
           FROM collections c
           JOIN barangays b ON b.id = c.barangay_id
           JOIN collectors col ON col.id = c.collector_id
           JOIN users u ON u.id = col.user_id
           ${whereSql}
           ORDER BY c.collection_date DESC, c.collection_time DESC
           LIMIT ${perPage} OFFSET ${offset}`,
        params,
      );

      return send(res, 200, {
        rows,
        pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
      });
    }

    /* --------------------------------------------------------- mutations */
    assertCsrf(req);
    const body = await jsonBody(req);
    const action = oneOf(body.action, ['create', 'update', 'delete'], { field: 'action' });

    if (action === 'delete') {
      const id = int(body.id, { field: 'id', min: 1 });
      // A collector may delete only their own row.
      const existing = await one(
        `SELECT id, collector_id FROM collections WHERE id = $1`,
        [id],
      );
      if (!existing) return send(res, 404, { error: 'Collection not found' });
      if (!staff && Number(existing.collector_id) !== Number(user.collector_id)) {
        return send(res, 403, { error: 'You can only delete your own collections' });
      }
      await run(`DELETE FROM collections WHERE id = $1`, [id]);
      return send(res, 200, { ok: true });
    }

    const fields = {
      barangay_id: int(body.barangay_id, { field: 'Barangay', min: 1 }),
      collector_id: int(body.collector_id, { field: 'Collector', min: 1 }),
      weight_kg: num(body.weight_kg, { field: 'Weight', min: 0.1, max: 100000 }),
      waste_type: oneOf(body.waste_type || 'Mixed', WASTE_TYPES, { field: 'Waste type' }),
      bags_count: body.bags_count === undefined || body.bags_count === ''
        ? 0
        : int(body.bags_count, { field: 'Bags', min: 0, max: 100000 }),
      notes: str(body.notes, { max: 2000 }),
      collection_date: dateRe(body.collection_date)
        ? body.collection_date
        : (() => {
            throw Object.assign(new Error('A valid collection date is required'), {
              statusCode: 400,
            });
          })(),
      collection_time: TIME_RE.test(String(body.collection_time || ''))
        ? body.collection_time
        : (() => {
            throw Object.assign(new Error('A valid collection time is required'), {
              statusCode: 400,
            });
          })(),
      status: oneOf(body.status || 'completed', STATUSES, { field: 'Status' }),
    };

    if (action === 'update') {
      const id = int(body.id, { field: 'id', min: 1 });
      const existing = await one(`SELECT collector_id FROM collections WHERE id = $1`, [id]);
      if (!existing) return send(res, 404, { error: 'Collection not found' });
      if (!staff && Number(existing.collector_id) !== Number(user.collector_id)) {
        return send(res, 403, { error: 'You can only edit your own collections' });
      }
      await run(
        `UPDATE collections
            SET barangay_id = $1, collector_id = $2, weight_kg = $3, waste_type = $4,
                bags_count = $5, notes = $6, collection_date = $7, collection_time = $8,
                status = $9
          WHERE id = $10`,
        [
          fields.barangay_id,
          fields.collector_id,
          fields.weight_kg,
          fields.waste_type,
          fields.bags_count,
          fields.notes,
          fields.collection_date,
          fields.collection_time,
          fields.status,
          id,
        ],
      );
      return send(res, 200, { ok: true, id });
    }

    // A collector recording for themselves does not need to pick a collector id.
    const collectorId = staff ? fields.collector_id : Number(user.collector_id);
    if (!collectorId) {
      return send(res, 400, {
        error: 'Your account is not linked to a collector record, so you cannot record collections',
      });
    }

    const rows = await run(
      `INSERT INTO collections
         (barangay_id, collector_id, weight_kg, waste_type, bags_count, notes,
          collection_date, collection_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        fields.barangay_id,
        collectorId,
        fields.weight_kg,
        fields.waste_type,
        fields.bags_count,
        fields.notes,
        fields.collection_date,
        fields.collection_time,
        fields.status,
      ],
    );

    return send(res, 201, { ok: true, id: Number(rows[0].id) });
  },
  ['GET', 'POST'],
);
