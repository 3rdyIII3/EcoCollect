import bcrypt from 'bcryptjs';
import { all, one, run } from './_lib/db.js';
import { requireAuth, isAdmin, assertCsrf } from './_lib/auth.js';
import { recordLoginEvent } from './_lib/audit.js';
import {
  withErrorHandling,
  send,
  jsonBody,
  int,
  str,
  oneOf,
  clientIp,
  userAgent,
} from './_lib/http.js';

/**
 * /api/users
 *   GET    list every account (admin only)
 *   POST   action = create | update | set_password | deactivate | reactivate
 *
 * Admin-only throughout. Every mutation re-checks the role inside the handler rather
 * than trusting the client's routing, so hiding the page is presentation and not the
 * security boundary - the same pattern api/barangays.js uses.
 */

const ROLES = ['admin', 'supervisor', 'collector'];

// Matches login.js and password.js. A password must never be stored at the old cost
// just because an admin created the account through here.
const BCRYPT_ROUNDS = 12;

/**
 * New-password policy, mirroring api/auth/password.js.
 *
 * Length is the only rule that reliably helps. Composition rules push people toward
 * Password1!, which is easier to guess than a long passphrase. The banned list catches
 * the defaults this project ships plus a few that any guessing script tries first;
 * matching is by substring, so admin1234 and admin12345 are caught too.
 */
const MIN_LENGTH = 12;
const BANNED = ['admin123', 'password', 'ecocollect', 'qwerty', 'letmein', 'welcome', '123456789012'];

function checkPassword(password) {
  if (password.length < MIN_LENGTH) {
    return `The password must be at least ${MIN_LENGTH} characters long.`;
  }
  if (BANNED.some((bad) => password.toLowerCase().includes(bad))) {
    return 'That password is too common. Choose something else.';
  }
  return null;
}

/** How many active admins exist. Used to refuse removing the last one. */
async function activeAdminCount(excludeId = null) {
  const row = await one(
    `SELECT COUNT(*)::int AS n FROM users
      WHERE role = 'admin' AND is_active = true AND ($1::int IS NULL OR id <> $1::int)`,
    [excludeId],
  );
  return row?.n ?? 0;
}

export default withErrorHandling(
  async (req, res) => {
    const me = await requireAuth(req);
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      // Supervisors can see the roster for reference; only admins can change it.
      const rows = await all(
        `SELECT u.id, u.username, u.full_name, u.role, u.contact, u.email,
                u.is_active, u.must_change_password, u.created_at,
                c.id AS collector_id, c.employee_id, c.route
           FROM users u
           LEFT JOIN collectors c ON c.user_id = u.id
          ORDER BY u.role, u.full_name`,
      );
      return send(res, 200, { rows });
    }

    // Every mutation is admin-only. Checked here rather than only in the router so the
    // API is safe regardless of which client calls it.
    if (!isAdmin(me)) {
      return send(res, 403, { error: 'Administrator access required' });
    }
    assertCsrf(req);

    const body = await jsonBody(req);
    const action = oneOf(body.action, ['create', 'update', 'set_password', 'deactivate', 'reactivate'], {
      field: 'action',
    });

    /* --------------------------------------------------------- set password */
    if (action === 'set_password') {
      const id = int(body.id, { field: 'id', min: 1 });
      const password = str(body.password, { max: 200, required: true, field: 'Password', trim: false });

      const problem = checkPassword(password);
      if (problem) return send(res, 400, { error: problem });

      const target = await one(`SELECT id, username FROM users WHERE id = $1`, [id]);
      if (!target) return send(res, 404, { error: 'User not found' });

      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // must_change_password is set, not cleared. An admin-set password is one the
      // owner has not chosen, so they are made to replace it at next sign-in - the same
      // treatment the seeded accounts get.
      await run(
        `UPDATE users SET password = $1, must_change_password = true WHERE id = $2`,
        [hashed, id],
      );

      // Record the credential reset in the audit trail. login_events has no dedicated
      // actor column, so the requesting admin's address is what gets hashed here -
      // which is the useful half when someone asks "who reset this account?" but does
      // mean the table records the admin's IP, not the target user's. Recorded against
      // the target's username so a query by account finds it.
      await recordLoginEvent({
        username: target.username,
        success: true,
        reason: `password_reset_by_admin:${me.username}`,
        ip: clientIp(req),
        ua: userAgent(req),
      });

      return send(res, 200, { ok: true, must_change_password: true });
    }

    /* --------------------------------------------------- deactivate/reactivate */
    if (action === 'deactivate' || action === 'reactivate') {
      const id = int(body.id, { field: 'id', min: 1 });
      const target = await one(`SELECT id, username, role, is_active FROM users WHERE id = $1`, [id]);
      if (!target) return send(res, 404, { error: 'User not found' });

      // An admin must not be able to lock themselves out, and must not be able to
      // remove the last way back in. Both are refused rather than warned about.
      if (action === 'deactivate') {
        if (Number(target.id) === Number(me.sub)) {
          return send(res, 400, { error: 'You cannot deactivate your own account' });
        }
        if (target.role === 'admin' && (await activeAdminCount(target.id)) === 0) {
          return send(res, 400, {
            error: 'This is the last active administrator. Promote another admin first.',
          });
        }
      }

      await run(`UPDATE users SET is_active = $1 WHERE id = $2`, [action === 'reactivate', id]);
      return send(res, 200, { ok: true });
    }

    /* -------------------------------------------------------------- create */
    const fields = {
      username: str(body.username, { max: 50, required: true, field: 'Username' }),
      full_name: str(body.full_name, { max: 100, required: true, field: 'Full name' }),
      role: oneOf(body.role || 'collector', ROLES, { field: 'Role' }),
      contact: str(body.contact, { max: 20 }),
      email: str(body.email, { max: 100 }),
    };

    if (action === 'create') {
      const password = str(body.password, { max: 200, required: true, field: 'Password', trim: false });
      const problem = checkPassword(password);
      if (problem) return send(res, 400, { error: problem });

      const clash = await one(`SELECT id FROM users WHERE lower(username) = lower($1)`, [
        fields.username,
      ]);
      if (clash) return send(res, 409, { error: 'That username is already taken' });

      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
      // Flagged for a forced change: the admin chose this password, not the user.
      const rows = await run(
        `INSERT INTO users (username, password, full_name, role, contact, email, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6, true)
         RETURNING id`,
        [fields.username, hashed, fields.full_name, fields.role, fields.contact, fields.email],
      );

      return send(res, 201, { ok: true, id: Number(rows[0].id), must_change_password: true });
    }

    /* -------------------------------------------------------------- update */
    const id = int(body.id, { field: 'id', min: 1 });
    const target = await one(`SELECT id, username, role FROM users WHERE id = $1`, [id]);
    if (!target) return send(res, 404, { error: 'User not found' });

    // Demoting the last active admin would leave nobody able to administer, so it is
    // refused for the same reason deactivating one is.
    if (
      target.role === 'admin' &&
      fields.role !== 'admin' &&
      (await activeAdminCount(target.id)) === 0
    ) {
      return send(res, 400, {
        error: 'This is the last active administrator. Promote another admin first.',
      });
    }

    // The username is deliberately not editable. It is the account's identity, appears
    // in audit rows, and is what an operator types to sign in; changing it silently
    // would break both. Re-create the account if the name is genuinely wrong.
    await run(
      `UPDATE users SET full_name = $1, role = $2, contact = $3, email = $4 WHERE id = $5`,
      [fields.full_name, fields.role, fields.contact, fields.email, id],
    );

    return send(res, 200, { ok: true, id });
  },
  ['GET', 'POST'],
);