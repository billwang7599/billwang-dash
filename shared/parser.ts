/**
 * Todoist-style quick-add parser. Each recogniser claims a span of the input;
 * claimed spans are never re-matched, so registration order encodes precedence
 * (specific before greedy). Content is whatever text is left over.
 *
 * Pure and dependency-free: the UI runs it per keystroke for the live preview,
 * the Worker re-runs it on submit, and the two can never disagree.
 */

import {
  type Civil,
  addDays,
  addMonths,
  addYears,
  civilFromDate,
  civilKey,
  daysInMonth,
  minutesOfDay,
  minutesToTime,
  nextWeekday,
  weekday,
} from "./civil.ts";
import type {
  DueDate,
  ParsedQuickAdd,
  ParsedToken,
  Priority,
  Recurrence,
} from "./types.ts";

export interface ParseOptions {
  now?: Date;
  timeZone?: string;
  /** Disambiguates "1/2": MDY = Jan 2 (default), DMY = 1 Feb. */
  dateFormat?: "MDY" | "DMY";
}

interface Span {
  start: number;
  end: number;
  type: ParsedToken["type"];
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2, tu: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, th: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

// Longest-first so "sunday" never gets clipped to "sun".
const WD = "sunday|saturday|thursday|wednesday|tuesday|monday|friday|thurs|thur|weds|tues|sun|mon|tue|wed|thu|fri|sat";
const MO = "january|february|september|december|november|october|august|march|april|june|july|jan|feb|sept|sep|oct|nov|dec|mar|apr|may|jun|jul|aug";

/** Named times of day, in minutes past midnight. */
const NAMED_TIMES: Record<string, number> = {
  morning: 9 * 60,
  noon: 12 * 60,
  midday: 12 * 60,
  afternoon: 14 * 60,
  evening: 18 * 60,
  tonight: 20 * 60,
  night: 20 * 60,
  midnight: 0,
};

export function parseQuickAdd(
  raw: string,
  options: ParseOptions = {},
): ParsedQuickAdd {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "UTC";
  const dateFormat = options.dateFormat ?? "MDY";
  const today = civilFromDate(now, timeZone);

  const spans: Span[] = [];
  const tokens: ParsedToken[] = [];
  /** Time of day implied by a non-time token, e.g. "every morning", "in 2 hours". */
  let impliedTimeMinutes: number | null = null;

  const claim = (start: number, end: number, type: ParsedToken["type"]) => {
    spans.push({ start, end, type });
    tokens.push({ type, text: raw.slice(start, end), start, end });
  };

  const free = (start: number, end: number) =>
    !spans.some((s) => start < s.end && end > s.start);

  /** Runs `re` over the input, skipping already-claimed regions. */
  const scan = (
    re: RegExp,
    type: ParsedToken["type"],
    onMatch: (m: RegExpExecArray) => boolean,
  ) => {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(raw)) !== null) {
      if (m[0].length === 0) {
        rx.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      if (onMatch(m)) claim(start, end, type);
    }
  };

  // Unambiguous sigils first, shielding the date recognisers from things
  // like "#jan-launch" or "@tomorrow-crew".

  let deadline: string | null = null;
  scan(/\{([^}]+)\}/, "deadline", (m) => {
    // The braces contain a date phrase in the same grammar, so just recurse.
    // Terminates because the inner text cannot itself contain a brace.
    const inner = parseQuickAdd(m[1].trim(), { now, timeZone, dateFormat });
    if (!inner.due) return false;
    deadline = inner.due.date;
    return true;
  });

  // `(?<!\S)` anchors each sigil to the start of a word, so "C#" stays text and
  // "bill@example.com" stays an email rather than becoming a label.
  let projectName: string | null = null;
  scan(/(?<!\S)#(?:"([^"]+)"|'([^']+)'|([^\s#@]+))/, "project", (m) => {
    if (projectName !== null) return false;
    projectName = (m[1] ?? m[2] ?? m[3]).trim();
    return true;
  });

  const labels: string[] = [];
  // Requires a letter after "@" so clock times like "@5pm" stay times.
  scan(/(?<!\S)@(?:"([^"]+)"|'([^']+)'|([A-Za-z_][^\s#@]*))/, "label", (m) => {
    const label = (m[1] ?? m[2] ?? m[3]).trim();
    if (!label || labels.includes(label)) return false;
    labels.push(label);
    return true;
  });

  let assignee: string | null = null;
  scan(/(?<!\S)\+([A-Za-z][^\s#@+]*)/, "assignee", (m) => {
    if (assignee !== null) return false;
    assignee = m[1];
    return true;
  });

  let priority: Priority = 4;
  // Separate boundaries: `\b` works before "p1" but not before "!!1", since
  // there is no word boundary between a space and "!".
  scan(/(?:\bp([1-4])|(?<!\S)!!([1-4]))\b/i, "priority", (m) => {
    priority = Number(m[1] ?? m[2]) as Priority;
    return true;
  });

  // ---- Duration ----------------------------------------------------------

  let durationMinutes: number | null = null;
  let rangeStartMinutes: number | null = null;

  scan(
    /\bfor\s+(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)\b/i,
    "duration",
    (m) => {
      if (durationMinutes !== null) return false;
      const value = Number(m[1]);
      const unit = m[2].toLowerCase();
      const minutes = unit.startsWith("h") ? value * 60 : value;
      if (!Number.isFinite(minutes) || minutes <= 0) return false;
      durationMinutes = Math.round(minutes);
      return true;
    },
  );

  // "3pm-4:30pm" sets start and duration, so it must beat the time matchers.
  scan(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
    "time",
    (m) => {
      if (rangeStartMinutes !== null) return false;
      const endMeridiem = m[6]?.toLowerCase();
      const startMeridiem = m[3]?.toLowerCase() ?? endMeridiem;
      // Bare "3-4" is far more likely a range of numbers than a time range.
      if (!startMeridiem && !m[2] && !m[5]) return false;

      const start = toMinutes(Number(m[1]), Number(m[2] ?? 0), startMeridiem);
      const end = toMinutes(Number(m[4]), Number(m[5] ?? 0), endMeridiem);
      if (start === null || end === null) return false;

      rangeStartMinutes = start;
      // An end before the start means it wrapped past midnight.
      if (durationMinutes === null) {
        durationMinutes = end > start ? end - start : 1440 - start + end;
      }
      return true;
    },
  );

  // ---- Recurrence --------------------------------------------------------

  let recurrence: Recurrence | null = null;
  const setRecurrence = (r: Recurrence) => {
    if (recurrence !== null) return false;
    recurrence = r;
    return true;
  };

  // "every jan 27" -> yearly on a fixed date.
  scan(
    new RegExp(`\\bevery(!)?\\s+(${MO})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"),
    "recurrence",
    (m) => {
      const month = MONTH_NAMES[m[2].toLowerCase()];
      const day = Number(m[3]);
      if (!month || day < 1 || day > daysInMonth(today.y, month)) return false;
      return setRecurrence({
        freq: "yearly",
        interval: 1,
        weekdays: [],
        month,
        monthDay: day,
        fromCompletion: Boolean(m[1]),
      });
    },
  );

  // "every monday", "every mon, wed and fri", "every other tuesday"
  scan(
    new RegExp(
      `\\bevery(!)?\\s+(other\\s+|\\d+\\s+)?((?:${WD})(?:\\s*(?:,|and|&)\\s*(?:${WD}))*)\\b`,
      "i",
    ),
    "recurrence",
    (m) => {
      const days = m[3]
        .split(/\s*(?:,|and|&)\s*/i)
        .map((d) => WEEKDAY_NAMES[d.trim().toLowerCase()])
        .filter((d): d is number => d !== undefined);
      if (days.length === 0) return false;
      return setRecurrence({
        freq: "weekly",
        interval: parseInterval(m[2]),
        weekdays: [...new Set(days)].sort(),
        month: null,
        monthDay: null,
        fromCompletion: Boolean(m[1]),
      });
    },
  );

  // "every day", "every 3 weeks", "every other month", "every weekday"
  scan(
    /\bevery(!)?\s+(other\s+|\d+\s+)?(days|day|weeks|week|months|month|years|year|weekdays|weekday|workdays|workday|weekends|weekend|mornings|morning|afternoons|afternoon|evenings|evening|nights|night)\b/i,
    "recurrence",
    (m) => {
      const interval = parseInterval(m[2]);
      const unit = m[3].toLowerCase().replace(/s$/, "");
      const fromCompletion = Boolean(m[1]);

      if (unit === "weekday" || unit === "workday") {
        return setRecurrence({
          freq: "weekly", interval, weekdays: [1, 2, 3, 4, 5],
          month: null, monthDay: null, fromCompletion,
        });
      }
      if (unit === "weekend") {
        return setRecurrence({
          freq: "weekly", interval, weekdays: [0, 6],
          month: null, monthDay: null, fromCompletion,
        });
      }
      // "every morning" is daily with an implied time of day.
      if (unit in NAMED_TIMES) {
        impliedTimeMinutes = NAMED_TIMES[unit];
        return setRecurrence({
          freq: "daily", interval, weekdays: [],
          month: null, monthDay: null, fromCompletion,
        });
      }

      const freq =
        unit === "day" ? "daily" :
        unit === "week" ? "weekly" :
        unit === "month" ? "monthly" : "yearly";
      return setRecurrence({
        freq, interval, weekdays: [],
        month: null, monthDay: null, fromCompletion,
      });
    },
  );

  // "every 27th" -> monthly on that day.
  scan(/\bevery(!)?\s+(\d{1,2})(?:st|nd|rd|th)\b/i, "recurrence", (m) => {
    const day = Number(m[2]);
    if (day < 1 || day > 31) return false;
    return setRecurrence({
      freq: "monthly", interval: 1, weekdays: [],
      month: null, monthDay: day, fromCompletion: Boolean(m[1]),
    });
  });

  scan(/\b(daily|weekly|monthly|yearly|annually)\b/i, "recurrence", (m) => {
    const word = m[1].toLowerCase();
    const freq =
      word === "daily" ? "daily" :
      word === "weekly" ? "weekly" :
      word === "monthly" ? "monthly" : "yearly";
    return setRecurrence({
      freq, interval: 1, weekdays: [],
      month: null, monthDay: null, fromCompletion: false,
    });
  });

  // ---- Dates -------------------------------------------------------------

  let dueCivil: Civil | null = null;
  let dateSpanEnd: number | null = null;
  const setDate = (c: Civil, endIndex: number) => {
    if (dueCivil !== null) return false;
    dueCivil = c;
    dateSpanEnd = endIndex;
    return true;
  };

  scan(/\b(\d{4})-(\d{2})-(\d{2})\b/, "date", (m) => {
    const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    if (!isRealDate(c)) return false;
    return setDate(c, m.index + m[0].length);
  });

  scan(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/, "date", (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const month = dateFormat === "MDY" ? a : b;
    const day = dateFormat === "MDY" ? b : a;
    const year = m[3] ? normaliseYear(Number(m[3])) : today.y;
    const c = { y: year, m: month, d: day };
    if (!isRealDate(c)) return false;
    // A bare "3/5" with no year means the next one to come around.
    const resolved = m[3] ? c : rollForwardYear(c, today);
    return setDate(resolved, m.index + m[0].length);
  });

  scan(
    new RegExp(`\\b(${MO})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, "i"),
    "date",
    (m) => {
      const month = MONTH_NAMES[m[1].toLowerCase()];
      const c = { y: m[3] ? Number(m[3]) : today.y, m: month, d: Number(m[2]) };
      if (!isRealDate(c)) return false;
      return setDate(m[3] ? c : rollForwardYear(c, today), m.index + m[0].length);
    },
  );

  scan(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MO})\\.?(?:,?\\s*(\\d{4}))?\\b`, "i"),
    "date",
    (m) => {
      const month = MONTH_NAMES[m[2].toLowerCase()];
      const c = { y: m[3] ? Number(m[3]) : today.y, m: month, d: Number(m[1]) };
      if (!isRealDate(c)) return false;
      return setDate(m[3] ? c : rollForwardYear(c, today), m.index + m[0].length);
    },
  );

  scan(
    /\bin\s+(\d+|an?)\s+(days|day|weeks|week|months|month|years|year|hours|hour|minutes|minute|mins|min)\b/i,
    "date",
    (m) => {
      const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
      const unit = m[2].toLowerCase().replace(/s$/, "");
      // "in 2 hours" is a point in time today, so it sets the clock too.
      if (unit === "hour" || unit === "minute" || unit === "min") {
        const delta = unit === "hour" ? n * 60 : n;
        const total = minutesOfDay(now, timeZone) + delta;
        impliedTimeMinutes = ((total % 1440) + 1440) % 1440;
        return setDate(addDays(today, Math.floor(total / 1440)), m.index + m[0].length);
      }
      const c =
        unit === "day" ? addDays(today, n) :
        unit === "week" ? addDays(today, n * 7) :
        unit === "month" ? addMonths(today, n) : addYears(today, n);
      return setDate(c, m.index + m[0].length);
    },
  );

  scan(new RegExp(`\\b(?:next|coming)\\s+(${WD})\\b`, "i"), "date", (m) =>
    setDate(nextWeekday(today, WEEKDAY_NAMES[m[1].toLowerCase()], false), m.index + m[0].length),
  );

  scan(new RegExp(`\\bthis\\s+(${WD})\\b`, "i"), "date", (m) =>
    setDate(nextWeekday(today, WEEKDAY_NAMES[m[1].toLowerCase()], true), m.index + m[0].length),
  );

  scan(/\bnext\s+(week|month|year)\b/i, "date", (m) => {
    const unit = m[1].toLowerCase();
    const c =
      unit === "week" ? nextWeekday(today, 1, false) :
      unit === "month" ? addMonths(today, 1) : addYears(today, 1);
    return setDate(c, m.index + m[0].length);
  });

  scan(/\b(?:this\s+|next\s+)?weekend\b/i, "date", (m) => {
    const isNext = /next/i.test(m[0]);
    const saturday = nextWeekday(today, 6, !isNext);
    return setDate(isNext ? addDays(saturday, 7) : saturday, m.index + m[0].length);
  });

  scan(/\bend\s+of\s+(?:the\s+)?(month|week)\b|\b(eom|eow)\b/i, "date", (m) => {
    const unit = (m[1] ?? m[2] ?? "").toLowerCase();
    const c = unit === "month" || unit === "eom"
      ? { ...today, d: daysInMonth(today.y, today.m) }
      : nextWeekday(today, 0, false); // end of week = coming Sunday
    return setDate(c, m.index + m[0].length);
  });

  scan(/\b(today|tod)\b/i, "date", (m) => setDate(today, m.index + m[0].length));
  scan(/\b(tomorrow|tmrw|tmr|tmw)\b/i, "date", (m) =>
    setDate(addDays(today, 1), m.index + m[0].length),
  );
  scan(/\b(yesterday|yest)\b/i, "date", (m) =>
    setDate(addDays(today, -1), m.index + m[0].length),
  );

  scan(new RegExp(`\\b(${WD})\\b`, "i"), "date", (m) =>
    setDate(nextWeekday(today, WEEKDAY_NAMES[m[1].toLowerCase()], true), m.index + m[0].length),
  );

  // ---- Times -------------------------------------------------------------

  let timeMinutes: number | null = null;
  const setTime = (minutes: number | null) => {
    if (minutes === null || timeMinutes !== null) return false;
    timeMinutes = minutes;
    return true;
  };

  scan(/\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i, "time", (m) =>
    setTime(toMinutes(Number(m[1]), Number(m[2] ?? 0), m[3])),
  );

  scan(/\b(?:at\s+|@\s*)(\d{1,2}):(\d{2})\b/i, "time", (m) =>
    setTime(toMinutes(Number(m[1]), Number(m[2]), undefined, true)),
  );

  scan(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, "time", (m) =>
    setTime(toMinutes(Number(m[1]), Number(m[2]), undefined, true)),
  );

  // Bare "at 5" — see toMinutes for the am/pm heuristic.
  scan(/\bat\s+(\d{1,2})\b/i, "time", (m) => setTime(toMinutes(Number(m[1]), 0)));

  scan(/\b(noon|midday|midnight)\b/i, "time", (m) =>
    setTime(NAMED_TIMES[m[1].toLowerCase()]),
  );

  // "morning"/"evening" are ordinary words on their own, so only treat them as
  // a time when they trail a date we already matched ("tomorrow morning").
  scan(/\b(morning|afternoon|evening|tonight|night)\b/i, "time", (m) => {
    const word = m[1].toLowerCase();
    if (word === "tonight") {
      if (dueCivil === null) setDate(today, m.index + m[0].length);
      return setTime(NAMED_TIMES.tonight);
    }
    if (dateSpanEnd === null) return false;
    if (raw.slice(dateSpanEnd, m.index).trim() !== "") return false;
    return setTime(NAMED_TIMES[word]);
  });

  // ---- Assemble ----------------------------------------------------------

  const effectiveTime = timeMinutes ?? rangeStartMinutes ?? impliedTimeMinutes;

  let due: DueDate | null = null;
  if (dueCivil !== null || recurrence !== null || effectiveTime !== null) {
    const anchor = dueCivil ?? firstOccurrence(recurrence, today);
    due = {
      date: civilKey(anchor),
      time: effectiveTime === null ? null : minutesToTime(effectiveTime),
      recurrence,
      timeZone,
    };
  }

  return {
    content: stripSpans(raw, spans),
    raw,
    projectName,
    labels,
    priority,
    due,
    deadline,
    durationMinutes,
    assignee,
    tokens: tokens.sort((a, b) => a.start - b.start),
  };
}

/**
 * Next date matching a recurrence rule. `from` is the date to advance past:
 * the previous due date, or the completion date for `every!` rules.
 */
export function nextOccurrence(
  recurrence: Recurrence,
  from: Civil,
  anchor: Civil = from,
): Civil {
  const interval = Math.max(1, recurrence.interval);

  switch (recurrence.freq) {
    case "daily":
      return addDays(from, interval);

    case "weekly": {
      if (recurrence.weekdays.length === 0) return addDays(from, 7 * interval);
      const current = weekday(from);
      const next = recurrence.weekdays.find((d) => d > current);
      if (next !== undefined) return addDays(from, next - current);
      // Wrapped past the week's end: first listed day of the next active week.
      const first = recurrence.weekdays[0];
      return addDays(from, 7 - current + first + 7 * (interval - 1));
    }

    case "monthly": {
      const day = recurrence.monthDay ?? anchor.d;
      const base = addMonths({ ...from, d: 1 }, interval);
      return { ...base, d: Math.min(day, daysInMonth(base.y, base.m)) };
    }

    case "yearly": {
      const month = recurrence.month ?? anchor.m;
      const day = recurrence.monthDay ?? anchor.d;
      let year = from.y;
      // Only advance the year if this year's date has already gone by.
      if (month < from.m || (month === from.m && day <= from.d)) {
        year += interval;
      }
      return { y: year, m: month, d: Math.min(day, daysInMonth(year, month)) };
    }
  }
}

/** Where a recurring task lands the first time, given no explicit date. */
function firstOccurrence(recurrence: Recurrence | null, today: Civil): Civil {
  if (!recurrence) return today;

  if (recurrence.freq === "weekly" && recurrence.weekdays.length > 0) {
    const current = weekday(today);
    if (recurrence.weekdays.includes(current)) return today;
    const next = recurrence.weekdays.find((d) => d > current);
    return next !== undefined
      ? addDays(today, next - current)
      : addDays(today, 7 - current + recurrence.weekdays[0]);
  }

  if (recurrence.freq === "monthly" && recurrence.monthDay !== null) {
    const day = Math.min(recurrence.monthDay, daysInMonth(today.y, today.m));
    if (day >= today.d) return { ...today, d: day };
    const base = addMonths({ ...today, d: 1 }, 1);
    return { ...base, d: Math.min(recurrence.monthDay, daysInMonth(base.y, base.m)) };
  }

  if (recurrence.freq === "yearly" && recurrence.month !== null) {
    const { month, monthDay } = { month: recurrence.month, monthDay: recurrence.monthDay ?? 1 };
    const thisYear = { y: today.y, m: month, d: Math.min(monthDay, daysInMonth(today.y, month)) };
    if (month > today.m || (month === today.m && thisYear.d >= today.d)) return thisYear;
    return { y: today.y + 1, m: month, d: Math.min(monthDay, daysInMonth(today.y + 1, month)) };
  }

  return today;
}

function parseInterval(raw: string | undefined): number {
  if (!raw) return 1;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "other") return 2;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Hour/minute to minutes past midnight. Without a meridiem we guess: "at 5"
 * means evening, "at 9" means morning. `strict24` skips the guess for
 * unambiguous input like "17:00".
 */
function toMinutes(
  hour: number,
  minute: number,
  meridiem?: string,
  strict24 = false,
): number | null {
  if (minute > 59 || hour > 23 || hour < 0) return null;

  if (meridiem) {
    const pm = meridiem.toLowerCase().startsWith("p");
    if (hour > 12 || hour === 0) return null;
    const h = hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
    return h * 60 + minute;
  }

  if (strict24 || hour >= 13) return hour * 60 + minute;
  // 1-7 reads as afternoon/evening; 8-12 reads as morning.
  const h = hour >= 1 && hour <= 7 ? hour + 12 : hour;
  return h * 60 + minute;
}

function isRealDate(c: Civil): boolean {
  return (
    c.m >= 1 && c.m <= 12 &&
    c.d >= 1 && c.d <= daysInMonth(c.y, c.m) &&
    c.y >= 1970 && c.y <= 2999
  );
}

/** "jan 5" in December means next January, not ten months ago. */
function rollForwardYear(c: Civil, today: Civil): Civil {
  if (c.m > today.m || (c.m === today.m && c.d >= today.d)) return c;
  const y = c.y + 1;
  return { y, m: c.m, d: Math.min(c.d, daysInMonth(y, c.m)) };
}

function normaliseYear(year: number): number {
  if (year >= 1000) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

function stripSpans(raw: string, spans: Span[]): string {
  if (spans.length === 0) return raw.trim();
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start > cursor) out += raw.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  out += raw.slice(cursor);
  // Collapse the whitespace and dangling connectives the cuts leave behind.
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .replace(/\b(at|on|by|due|every|for|in)\s*$/i, "")
    .trim();
}
