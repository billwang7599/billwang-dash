/**
 * Wall-clock date math. Tasks are scheduled against the calendar day the user
 * sees, not an instant — "tomorrow at 5pm" stays 5pm across a DST change or a
 * flight. Conversion to a real instant happens only in zonedToUtcMs().
 */

export interface Civil {
  y: number;
  /** 1-12 */
  m: number;
  /** 1-31 */
  d: number;
}

const dateKeyRe = /^(\d{4})-(\d{2})-(\d{2})$/;
const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;

const toUtcMs = (c: Civil) => Date.UTC(c.y, c.m - 1, c.d);

function fromUtcMs(ms: number): Civil {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function parts(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  const found = new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).formatToParts(date);
  return (type: string) => Number(found.find((p) => p.type === type)?.value ?? "0");
}

export function civilFromDate(date: Date, timeZone: string): Civil {
  const get = parts(date, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function minutesOfDay(date: Date, timeZone: string): number {
  const get = parts(date, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return get("hour") * 60 + get("minute");
}

export function civilKey(c: Civil): string {
  return `${String(c.y).padStart(4, "0")}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

export function civilFromKey(key: string): Civil | null {
  const m = dateKeyRe.exec(key);
  if (!m) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  // Rejects 2026-02-31 and friends, which would otherwise roll over silently.
  return civilKey(fromUtcMs(toUtcMs(c))) === key ? c : null;
}

export function addDays(c: Civil, n: number): Civil {
  return fromUtcMs(toUtcMs(c) + n * 86_400_000);
}

/** Clamps to end of month, so Jan 31 + 1 month = Feb 28. */
export function addMonths(c: Civil, n: number): Civil {
  const total = c.y * 12 + (c.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(c.d, daysInMonth(y, m)) };
}

export const addYears = (c: Civil, n: number) => addMonths(c, n * 12);

export const daysInMonth = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 0 = Sunday ... 6 = Saturday */
export const weekday = (c: Civil) => new Date(toUtcMs(c)).getUTCDay();

export const diffDays = (a: Civil, b: Civil) =>
  Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);

/** Next date on/after `from` falling on `targetWeekday`. */
export function nextWeekday(from: Civil, targetWeekday: number, includeToday = true): Civil {
  const delta = (targetWeekday - weekday(from) + 7) % 7;
  if (delta === 0 && includeToday) return from;
  return addDays(from, delta === 0 ? 7 : delta);
}

function offsetMsAt(utcMs: number, timeZone: string): number {
  const get = parts(new Date(utcMs), timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const asIfUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second"),
  );
  return asIfUtc - utcMs;
}

/**
 * Wall-clock time in `timeZone` to a UTC instant. Two passes: the first guesses
 * the offset from the naive instant, the second corrects it. Resolves correctly
 * either side of a DST transition.
 */
export function zonedToUtcMs(c: Civil, minutesPastMidnight: number, timeZone: string): number {
  const naive = Date.UTC(c.y, c.m - 1, c.d) + minutesPastMidnight * 60_000;
  return naive - offsetMsAt(naive - offsetMsAt(naive, timeZone), timeZone);
}

export function parseTimeToMinutes(time: string): number {
  const m = timeRe.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export function minutesToTime(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}
