/**
 * Formatting helpers shared by the pages.
 *
 * The DATE normalisation here is deliberate, not defensive padding. A Postgres
 * `date` column arrives as a JS Date from one driver and as a 'YYYY-MM-DD' string
 * from another, so anything that string-concatenates it can render "Invalid Date" in
 * development and quietly render correctly in production (or the reverse). Reading
 * the UTC parts keeps the calendar day intact regardless of the reader's timezone -
 * using local getters would shift a collection to the previous day west of UTC.
 */

/** Postgres DATE -> 'YYYY-MM-DD', whatever the driver handed us. */
export function dateOnly(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already a string: keep only the date part.
  return String(value).slice(0, 10);
}

/** Postgres TIME -> 'HH:MM'. */
export function timeOnly(value) {
  if (!value) return '';
  return String(value).slice(0, 5);
}

/** 'YYYY-MM-DD' + 'HH:MM' -> a locale string, parsed as local wall-clock time. */
export function formatDateTime(dateValue, timeValue) {
  const d = dateOnly(dateValue);
  if (!d) return '';
  const t = timeOnly(timeValue);
  const parsed = new Date(`${d}T${t || '00:00'}`);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Short axis label for a chart, e.g. 'Oct 5'. */
export function shortDate(dateValue) {
  const d = dateOnly(dateValue);
  if (!d) return '';
  const parsed = new Date(`${d}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function num(value, digits = 1) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function int(value) {
  return Number(value || 0).toLocaleString();
}

export function titleCase(value) {
  const s = String(value || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
