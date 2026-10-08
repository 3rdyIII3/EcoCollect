import { Pool } from '@neondatabase/serverless';

/**
 * Neon serverless driver.
 *
 * Uses Neon's HTTP transport rather than a WebSocket/pg Pool on purpose: serverless
 * functions are short-lived and horizontally scaled, so holding a TCP socket is
 * both unreliable (idle connections get dropped) and a connection-exhaustion risk.
 *
 * The driver is `Pool`, not `neon()`. In this version neon() is a tagged-template
 * function whose interpolated values become `$1` placeholders, so a SQL string passed
 * through it is treated as a parameter *value* rather than as SQL - every query here
 * failed with `syntax error at or near "$1"`. Pool.query(text, params) treats the first
 * argument as SQL and binds the second properly, which is what this codebase's queries
 * need. It is also the shape PGlite provides, so the tests drive the real handlers
 * unchanged.
 */
let sql;
let driverInjected = false;

export function db() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw Object.assign(new Error('DATABASE_URL is not set'), { statusCode: 500 });
    }
    const pool = new Pool({ connectionString: url });
    sql = {
      async query(text, params = []) {
        const result = await pool.query(text, params);
        // Pool returns { rows, fields, ... }; callers expect the rows array directly,
        // which is what neon() and PGlite both return.
        return result.rows ?? [];
      },
    };
  }
  return sql;
}

/**
 * Test-only: swap the Neon driver for an in-process Postgres (PGlite).
 *
 * The neon() driver and PGlite both expose query(text, params) -> rows, so the
 * handler code under test is byte-identical to production. Exists so scripts/test-api.mjs
 * can exercise the real request path without a hosted database. Never called by
 * application code.
 */
export function __setDriverForTests(driver) {
  sql = driver;
  driverInjected = true;
}

/**
 * True when something other than Neon's HTTP driver is in use - i.e. the local dev
 * server, which injects PGlite. Lets /api/health report the database as working
 * during local development, where DATABASE_URL is correctly absent.
 */
export function isDriverInjected() {
  return driverInjected;
}

export async function all(text, params = []) {
  const rows = await db().query(text, params);
  return rows;
}

export async function one(text, params = []) {
  const rows = await db().query(text, params);
  return rows[0] ?? null;
}

export async function scalar(text, params = []) {
  const rows = await db().query(text, params);
  if (!rows.length) return null;
  return Object.values(rows[0])[0];
}

export async function run(text, params = []) {
  const rows = await db().query(text, params);
  return rows;
}

/**
 * Postgres has no MySQL FIELD(). Used for the weekday ordering in schedules
 * ("order by weekday, not alphabetically").
 *
 * `values` must be a hardcoded constant (e.g. WEEKDAYS below), never user input:
 * the literals are interpolated into the SQL on purpose so each CASE branch gets
 * its own comparison value.
 */
export function field(column, values) {
  const branches = values
    .map((_, i) => `WHEN '${values[i].replace(/'/g, "''")}' THEN ${i + 1}`)
    .join(' ');
  return `CASE ${column} ${branches} ELSE 99 END`;
}

/** MySQL IFNULL(a, b) -> COALESCE(a, b). Exported for readability at call sites. */
export function coalesce(...exprs) {
  return `COALESCE(${exprs.join(', ')})`;
}

/**
 * The application's local timezone.
 *
 * Vercel functions run in UTC, but "collected today", "this month" and the weekday
 * a schedule fires on are all local-calendar questions. Ipil is in
 * Asia/Manila (UTC+8), so without this a collection logged at 07:00 local would
 * still count as "yesterday" until 08:00 UTC. Every date filter in this codebase
 * goes through here.
 */
export function localTz() {
  const tz = process.env.APP_TIMEZONE || 'Asia/Manila';
  // Validated because the value is interpolated into SQL below. IANA names look
  // like Area/Location; anything else is rejected rather than escaped.
  if (!/^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z0-9_+-]+)+$/.test(tz)) {
    throw Object.assign(new Error('APP_TIMEZONE is not a valid IANA timezone name'), {
      statusCode: 500,
    });
  }
  return tz;
}

/** Current local calendar date, e.g. 2026-07-23. */
export function localDateSql() {
  return `(now() AT TIME ZONE '${localTz()}')::date`;
}

/** Current local weekday name, e.g. 'Thursday' (matches the schedules enum). */
export function localWeekdaySql() {
  return `to_char(now() AT TIME ZONE '${localTz()}', 'FMDay')`;
}

/** First day of the current local month. */
export function localMonthStartSql() {
  return `date_trunc('month', now() AT TIME ZONE '${localTz()}')::date`;
}

/** WEEKDAYS in Monday-first order, for `field()` and `weekdayCase()`. */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function weekdayCase(column) {
  return field(column, WEEKDAYS);
}
