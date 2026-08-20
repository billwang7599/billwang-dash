import { civilFromDate, civilFromKey, civilKey, diffDays } from "../shared/civil.ts";
import type { DueDate, Priority, Recurrence } from "../shared/types.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const utcDate = (c: { y: number; m: number; d: number }) =>
  new Date(Date.UTC(c.y, c.m - 1, c.d));

export const priorityName = (p: Priority) =>
  ["Urgent", "High", "Medium", "Normal"][p - 1];

export const todayKey = (timeZone: string) =>
  civilKey(civilFromDate(new Date(), timeZone));

export const formatInstant = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", timeZone });

/** "Today", "Tomorrow", "Sat 8 Aug" — plus time and repeat rule if set. */
export function formatDueLabel(due: DueDate, timeZone?: string): string {
  const parts = [formatDateLabel(due.date, timeZone ?? due.timeZone)];
  if (due.time) parts.push(formatTime(due.time));
  if (due.recurrence) parts.push(formatRecurrence(due.recurrence));
  return parts.join(" · ");
}

export function formatDateLabel(dateKey: string, timeZone: string): string {
  const civil = civilFromKey(dateKey);
  if (!civil) return dateKey;

  const today = civilFromDate(new Date(), timeZone);
  const delta = diffDays(today, civil);

  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  if (delta < 0) return `${Math.abs(delta)}d overdue`;
  // Within the coming week a weekday name places faster than a date.
  if (delta < 7) return DAYS[utcDate(civil).getUTCDay()];

  return utcDate(civil).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: civil.y === today.y ? undefined : "numeric",
    timeZone: "UTC",
  });
}

function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

export function formatRecurrence(r: Recurrence): string {
  const every = r.fromCompletion ? "every!" : "every";

  if (r.freq === "weekly" && r.weekdays.length > 0) {
    const isWeekdays = r.weekdays.length === 5 && r.weekdays.every((d) => d >= 1 && d <= 5);
    return isWeekdays
      ? `${every} weekday`
      : `${every} ${r.weekdays.map((d) => DAYS[d].slice(0, 3)).join(", ")}`;
  }

  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  if (r.interval === 1) return `${every} ${unit}`;
  if (r.interval === 2) return `${every} other ${unit}`;
  return `${every} ${r.interval} ${unit}s`;
}
