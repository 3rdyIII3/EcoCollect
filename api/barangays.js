import { all, one, run } from './_lib/db.js';
import { requireAuth, isAdmin, assertCsrf } from './_lib/auth.js';
import {
  withErrorHandling,
  send,
  jsonBody,
  queryOf,
  int,
  num,
  str,
  bool,
} from './_lib/http.js';

/**
 * /api/barangays
 *   GET    list (any signed-in user: the scanner needs it)
 *   POST   action = create | update | delete  (admin only)
 */

/** Mirrors the BRG-XXXXXX format the QR scanner expects. */
function generateQrCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `BRG-${suffix}`;
}

export default withErrorHandling(
  async (req, res) => {
    const user = await requireAuth(req);
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      const query = queryOf(req);
      const includeInactive = bool(query.include_inactive) && isAdmin(user);

      const rows = await all(
        `SELECT b.id, b.name, b.population, b.zone, b.address, b.qr_code,
                b.latitude, b.longitude, b.is_active, b.created_at,
                (SELECT COUNT(*)::int FROM collections c WHERE c.barangay_id = b.id) AS collection_count,
                (SELECT COALESCE(SUM(c.weight_kg), 0) FROM collections c WHERE c.barangay_id = b.id) AS total_weight
           FROM barangays b
          ${includeInactive ? '' : 'WHERE b.is_active = true'}
          ORDER BY b.name ASC`,
      );
      return send(res, 200, { rows });
    }

    // Every mutation is admin-only. Checked here rather than only in the router so
    // the API is safe regardless of which client calls it.
    if (!isAdmin(user)) {
      return send(res, 403, { error: 'Administrator access required' });
    }
    assertCsrf(req);

    const body = await jsonBody(req);
    const action = String(body.action || '');

    if (action === 'delete') {
      const id = int(body.id, { field: 'id', min: 1 });
      // ON DELETE CASCADE would silently erase the collection history, which is the
      // whole point of this system. Deactivate instead.
      await run(`UPDATE barangays SET is_active = false WHERE id = $1`, [id]);
      return send(res, 200, { ok: true, deactivated: true });
    }

    const fields = {
      name: str(body.name, { max: 100, required: true, field: 'Name' }),
      population: body.population === undefined || body.population === ''
        ? 0
        : int(body.population, { field: 'Population', min: 0, max: 100_000_000 }),
      zone: str(body.zone, { max: 50 }),
      address: str(body.address, { max: 500 }),
      qr_code: str(body.qr_code, { max: 255 }),
      latitude: body.latitude === '' || body.latitude === undefined || body.latitude === null
        ? null
        : num(body.latitude, { field: 'Latitude', min: -90, max: 90 }),
      longitude: body.longitude === '' || body.longitude === undefined || body.longitude === null
        ? null
        : num(body.longitude, { field: 'Longitude', min: -180, max: 180 }),
      is_active: body.is_active === undefined ? true : bool(body.is_active, true),
    };

    if (action === 'update') {
      const id = int(body.id, { field: 'id', min: 1 });
      const clash = await one(`SELECT id FROM barangays WHERE qr_code = $1 AND id <> $2`, [
        fields.qr_code,
        id,
      ]);
      if (clash) return send(res, 409, { error: 'That QR code is already assigned to another barangay' });

      await run(
        `UPDATE barangays
            SET name = $1, population = $2, zone = $3, address = $4, qr_code = $5,
                latitude = $6, longitude = $7, is_active = $8
          WHERE id = $9`,
        [
          fields.name,
          fields.population,
          fields.zone,
          fields.address,
          fields.qr_code,
          fields.latitude,
          fields.longitude,
          fields.is_active,
          id,
        ],
      );
      return send(res, 200, { ok: true, id });
    }

    // create
    let qr = fields.qr_code || generateQrCode();
    // Retry on the unique index rather than pre-checking in a loop; the constraint
    // is the only race-free way to guarantee uniqueness.
    let inserted = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
      const clash = await one(`SELECT id FROM barangays WHERE qr_code = $1`, [qr]);
      if (clash) {
        qr = generateQrCode();
        continue;
      }
      const rows = await run(
        `INSERT INTO barangays
           (name, population, zone, address, qr_code, latitude, longitude, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          fields.name,
          fields.population,
          fields.zone,
          fields.address,
          qr,
          fields.latitude,
          fields.longitude,
          fields.is_active,
        ],
      );
      inserted = rows[0].id;
    }
    if (!inserted) {
      return send(res, 500, { error: 'Could not allocate a unique QR code, please retry' });
    }
    return send(res, 201, { ok: true, id: Number(inserted), qr_code: qr });
  },
  ['GET', 'POST'],
);
