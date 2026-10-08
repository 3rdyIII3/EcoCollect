# EcoCollect — React + Vercel port

A rewrite of the PHP/MySQL EcoCollect app as a React SPA with Node serverless
functions, built to deploy on Vercel with Neon Postgres.

The original PHP app lives in the sibling folder `../R_Rivera` and is untouched.

---

## What is in this pass

Ported and working:

| Area | Notes |
| --- | --- |
| Auth | Staff and admin sign-in pages, security question, logout, change own password, session JWT, CSRF, escalating throttle, audit log |
| Shell | Sidebar + topbar with role-gated nav, notification bell |
| Dashboard | KPI tiles, 3 charts, waste-by-barangay and collector tables |
| Collections | List, filters, pagination, create, delete |
| Barangays | List, create, edit, view, deactivate/reactivate |
| Users | Admin only — create accounts, change roles, reset passwords, activate/deactivate |
| Rankings | Staff only — per-capita barangay ranking, overall or by waste stream |
| Notifications | Staff only — inbox, mark read, archive, delete |

Not ported yet, and deliberately absent from the navigation rather than shown as
locked links: Collectors, Schedules, QR Scanner, QR Codes, Dumping Reports,
Analytics, Settings. A sidebar full of dead links to placeholder pages reads as a
broken app. See "Remaining work" below.

---

## Deploy to Vercel

### 1. Create the database

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. Copy the **pooled** connection string (Connection Details → Pooled connection).
   Use the pooled one; Vercel functions should not hold direct connections.

### 2. Add environment variables

In Vercel: Project → Settings → Environment Variables. Copy `.env.example`.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon pooled connection string |
| `JWT_SECRET` | yes | ≥32 chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_TIMEZONE` | no | Defaults to `Asia/Manila`. **Read this** — see below. |
| `NODE_ENV` | — | Do not set it to `development` on Vercel. Session cookies are `Secure` unless that exact value is present, so anything else is safe. |

### 3. Apply the schema

```bash
npm install
DATABASE_URL="postgresql://..." npm run db:migrate -- --seed
```

This **drops and recreates every table**, so point it at a fresh database.

The `--seed` accounts use the published password `admin123` and are flagged
`must_change_password`, so the first sign-in goes straight to a forced change and
the app shows nothing else until one is chosen.

### 4. Deploy

```bash
npx vercel          # first time
npx vercel --prod
```

Vercel auto-detects Vite (`vercel.json` pins `outputDirectory: dist`). SPA deep
links work via the rewrite to `/index.html` that excludes `/api`.

---

## Run it locally

Two options.

**With the Vercel CLI** (closest to production):

```bash
npx vercel dev
```

**Without it** — an in-process Postgres, no hosted database needed:

```bash
npm install
npm run build
node scripts/dev-server.mjs     # http://localhost:4321
node scripts/seed-demo.mjs      # optional: 45 days of realistic data
```

Log in with `admin` / `admin123`. Because that password is published, the app
sends you straight to a change-password screen and shows nothing else until you
pick a new one (12+ characters).

Two sign-in pages exist:

| Route | For |
| --- | --- |
| `/login` | Everyone — collectors, supervisors, admins |
| `/admin/login` | Administrators only; a non-admin account that authenticates there is signed straight back out |

The split is presentation and routing, not a second security boundary. Both pages
post to the same `POST /api/auth/login`, so the throttle, CSRF check and password
comparison are identical. What makes it worth having is operational: an admin can
be handed one link, and a staff member who lands on the wrong page finds out
immediately instead of quietly getting a session that looks fine but 403s on every
admin action.

---

## Login protection

What the login endpoint does:

| Control | Detail |
| --- | --- |
| Security question | An arithmetic challenge (`7 + 4`) checked server-side before the database is touched. The answer is signed into an httpOnly cookie and never sent to the browser |
| Escalating throttle | Two scopes — per network (HMAC of IP + UA) and per account (HMAC of the username). Both counters are written from one row so they cannot drift |
| Backoff, not a flat lockout | 1-3 failures: no lock at all. 4th onward: 30s, 60s, 120s, 240s, 480s, then the full 15 minutes. `Retry-After` tells the client how long to wait |
| bcrypt cost 12 | Existing hashes are read for their cost and upgraded on their owner's next successful login, so no migration is needed |
| Forced change on default | Accounts seeded with the published `admin123` are flagged `must_change_password`; the app shows nothing else until one is chosen |
| CSRF | Double-submit token required on every POST, including login and password change |
| Timing-equalised failures | A real bcrypt hash is compared even for unknown usernames, at the same cost factor, so response time does not reveal which accounts exist |
| Immediate deactivation | `/api/auth/me` re-checks the user against the database on each call rather than trusting the token until expiry |
| Audit trail | Every attempt, success or failure, lands in `login_events` with an HMAC'd address. 90-day retention, cleaned inline |

### The security question, honestly

It is a speed bump, not a control. It stops an unattended script hammering the endpoint
before it reaches the database; it does not stop a determined attacker, who can simply
solve arithmetic. The throttle is what limits password guessing.

Two deliberate choices:

- **Arithmetic, not a distorted image.** An image captcha is now routinely solved by
  OCR and is genuinely hard for a person to read on a phone in poor light, which is
  how most collectors will sign in. Plain text stays legible, works with a screen
  reader, and needs no image pipeline.
- **A wrong answer does NOT count toward the throttle.** The obvious design treats a
  bad captcha like a bad password, and that is a denial-of-service hole: anyone who
  knows a username could lock a real user out of the escalating backoff window without
  knowing any password at all. Guessing the captcha is therefore free — sound, because
  solving it gains nothing, since the per-account throttle on the credentials still
  applies.

`POST /api/auth/password` changes only the signed-in user's own password — the user
id comes from the session token, never the request body. It requires the current
password even when the caller holds a valid session, so someone at an unlocked
signed-in machine cannot take the account over. New passwords need 12+ characters
and the defaults this project ships are rejected outright; length is the only rule,
because composition rules push people toward `Password1!`.

Because that current-password check makes the endpoint a password oracle for anyone
holding a stolen session, it shares the login throttle: wrong guesses there count
toward the same counters and are audited as `password_change_denied`.

Not implemented: MFA on the admin role, and IP allow-listing for admin login. Both
are worth considering before this holds real municipal data.

One limitation worth stating plainly: `X-Forwarded-For` is client-settable, so a
determined attacker can vary it to dodge the per-network throttle. That is why the
per-account scope exists — a forged header cannot give an attacker a fresh allowance
against one username. Fully closing it needs the address from Vercel's own request
metadata rather than a header.

---

## Tests

```bash
npm test
```

Five suites, none needing a hosted database:

| Script | Covers |
| --- | --- |
| `check-api.mjs` | Every `api/` handler imports and exports a callable function |
| `test-auth.mjs` | Security question issue/verify, CSRF, JWT, cookie flags, throttle backoff curve, rehash detection, timezone guard, validators |
| `test-db.mjs` | `schema.sql` plus the real queries, against Postgres via PGlite/WASM |
| `test-api.mjs` | Handlers as HTTP requests: captcha gate, auth, roles, validation, throttle scopes, rehash-on-login, audit log, forced password change, security headers |
| `test-fullstack.mjs` | Boots the dev server and exercises it over real HTTP |

`test-db.mjs` and `test-api.mjs` run real Postgres (PGlite), which is what caught
the FK ordering bug and the parameter-placeholder bugs during the port.

The throttle tests assert the security-critical direction: that a **correct password
is still refused while locked out**, that the account is locked from a *different*
source address (credential stuffing), and that an unrelated client is unaffected.
A backoff that waved through a valid password during the lock would be useless.

The captcha tests assert the property that is easy to get wrong: that **repeated wrong
answers do not throttle the account**. That is the denial-of-service guard — if they
did count, the lockout would be weaponisable against any user whose name is known.

### Screenshots

```bash
node scripts/screenshots.mjs   # authenticated pages, via Chrome DevTools Protocol
node scripts/seed-demo.mjs     # 45 days of demo data first
```

`screenshots.mjs` also fails loudly on console errors, which is the only way to catch
a React render crash on a page the API tests cannot see.

---

## Things that changed and why

**Sessions became stateless.** The PHP version kept per-tab sessions in files on
disk, which serverless cannot do. Sessions are now a signed JWT in an httpOnly
cookie. Consequence: logout clears the cookie but cannot revoke a token that was
already copied — it stays valid until it expires (8h). `/api/auth/me` re-checks the
user against the database on every call, so deactivating an account takes effect
immediately rather than at expiry.

**Brute-force throttling moved into the database.** The PHP version counted
failures in a JSON file per IP. There is no writable disk and in-memory state is
reset on every cold start, so counters live in a `login_attempts` table keyed by an
HMAC of IP + user agent. Raw IPs are not stored. Each row now also carries an HMAC
of the username, so one write feeds both the per-network and per-account scopes.

**Login audits moved into the database too**, as `login_events`. The PHP version had
no record of who attempted what. Every attempt is now written with an HMAC'd address
and a 90-day inline cleanup.



**`APP_TIMEZONE` is not optional in practice.** Vercel functions run in UTC. Without
a timezone, "collected today", "this month" and weekday schedules would be computed
in UTC, so a collection logged at 07:00 in Ipil (UTC+8) would count as yesterday.
Every date filter goes through `localDateSql()` in `api/_lib/db.js`.

**Existing passwords carry over.** PHP's `password_hash()` produces `$2y$` bcrypt
hashes, which `bcryptjs` verifies unchanged — verified against your real dump in
`scripts/`. You do not need to reset anyone's password. Those hashes are at the old
cost, so they are upgraded to 12 the first time each owner signs in.

**MySQL → Postgres.** Dialect changes are listed at the top of `db/schema.sql`. Two
were not mechanical: `collections` had to be created *after* `schedules` (Postgres
validates foreign key targets immediately, unlike the dump's
`SET FOREIGN_KEY_CHECKS=0`), and the completion-rate calculation was comparing
collections against schedule *rows*, which produced values like 1800%. It now
expands schedules across the matching days in the window.

**`htmlspecialchars()` is gone** — React escapes by default, and nothing in the app
injects raw HTML.

---

## Security notes

Fixed during the port:

- The old `settings` handler persisted every unrecognised POST field, which left
  **plaintext passwords** in the `settings` table (`new_password=admin123` and so
  on). `schema.sql` adds a trigger that refuses any key matching
  `password|secret|token|csrf|api_key`, and the seed deletes the old rows.
- The PHP `sessions/` directory was inside the web root and its files were served
  over HTTP to anyone who knew a session id. `sessions/.htaccess` in the old app now
  returns 403. (Not relevant to this deployment, but worth fixing if the PHP app is
  still running.)
- Login responses are constant-time-ish for unknown usernames: a real bcrypt hash is
  compared even when the user does not exist, so timing does not reveal which
  usernames are registered.
- The seeded admin password was `admin123` in the README and in `db/migrate.mjs`.
  Seeded accounts are now flagged `must_change_password`, and the app blocks every
  other route until one is chosen.

Fixed while hardening the login path:

- The throttle locked a client out for a flat 15 minutes after 5 failures, keyed on
  IP + user agent. Five wrong passwords from a colleague on a shared office
  connection locked out everyone behind that NAT, and rotating source addresses got
  an attacker 5 fresh attempts each. Replaced with escalating backoff across two
  scopes (per network and per account).
- `Secure` on session cookies depended on `NODE_ENV === 'production'`. A deployment
  that did not set it would have sent session cookies without the flag. Cookies are
  now Secure unless the app is explicitly in development.
- bcrypt cost was 10, below the current recommendation. New hashes are cost 12 and
  old ones upgrade on their owner's next login. The timing-equaliser hash for unknown
  usernames was a pinned literal at cost 10; once real hashes moved to 12 that would
  have made unknown usernames *faster*, so it is now generated at the current cost.
- API responses carried no `X-Frame-Options`, `Referrer-Policy` or HSTS.
- There was no record of login attempts at all. `login_events` now logs every
  success and failure.
- `POST /api/auth/password` did not exist, so there was no way to change a password
  from the app at all.
- There was no login captcha at all, so a script could POST to `/api/auth/login`
  unattended with nothing to solve.
- Both sign-in pages shared one component, so the admin page is a re-tinted variant
  rather than a fork. That matters more than it sounds: a fix applied to one (the
  throttled-response message, clearing the password field on failure) would otherwise
  have been silently missing from the other.

Still true, and worth knowing:

- `change-admin.php` in the old app lets anyone POST and overwrite the admin
  password. It has CSRF but no authentication, and CSRF does not stop a direct
  attacker. That endpoint should require an existing admin session or be deleted.
  It has no equivalent here.
- `X-Forwarded-For` is client-settable, so the per-network throttle can be dodged by
  varying it. The per-account scope is what actually holds.
- Sessions are stateless JWTs, so a password change does not invalidate tokens
  already issued for that account. They remain valid until their 8h expiry. Fixing
  this properly needs server-side session state.
- MFA is not implemented on the admin role.
- The security question is a speed bump only. It raises the cost of an unattended
  script and nothing more; it is not, and should not be described as, bot-proof.
- `/admin/login` is not restricted by address. Any admin password works from anywhere;
  the page is a convenience, not a perimeter. Network-level restriction for admin
  access is a reverse-proxy or WAF rule, and would break field access if misapplied.

---

## Remaining work

Each item needs an endpoint plus a page. The `field()`/`weekdayCase()` helpers in
`api/_lib/db.js` already cover the MySQL `FIELD()` ordering the schedules module
relied on.

- **Schedules** — weekday ordering helper ready; needs CRUD and a weekly grid.
- **QR Scanner** — camera via `html5-qrcode`; needs an endpoint to resolve a scanned
  code to a barangay and check today's collection.
- **QR Codes** — print sheet; codes are already stored per barangay.
- **Collectors / Users** — CRUD, including role changes and linking a collector to a
  user record. Anyone creating an account here needs to hash at cost 12 and can set
  `must_change_password`, matching what `api/auth/password.js` does.
- **Notifications** — listing is live; mark-read/archive/delete still needed.
- **Settings** — needs an endpoint with an explicit key allowlist (not a
  deny-list). Password changes now live at `POST /api/auth/password`.
- **Dumping reports** — CRUD plus photo upload, which means [Vercel Blob](https://vercel.com/docs/storage/vercel-blob).
- **Rankings / Analytics** — per-capita ranking; charts already render on the
  dashboard.
- **Admin security log** — `login_events` is being written but nothing reads it yet.
  Needs an admin-only page listing recent attempts and failures per account.
- **Session revocation** — tokens are stateless, so logout and password changes
  cannot invalidate an already-issued token before it expires (8h). Needs a server-side
  session table or a token version column on `users`.
- **MFA** — TOTP for the admin role, verified before the session token is issued.

---

## Local files that must never be committed

`.env`, `.env.local`, and `.pglite/` (local dev database) are git-ignored. The
`.htaccess` in this folder blocks Apache from serving this directory, because it
lives under `C:\xampp\htdocs`.
