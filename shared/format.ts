import { civilFromKey } from "./civil.ts";
import type { Priority, Recurrence } from "./types.ts";

/**
 * Date, time and priority wording shared by the app (src/format.ts re-exports these)
 * and the server, which uses it for the assistant's approval cards.
 */

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const utcDate = (c: { y: number; m: number; d: number }) =>
    new Date(Date.UTC(c.y, c.m - 1, c.d));

export const priorityName = (p: Priority) =>
    ["Urgent", "High", "Medium", "Normal"][p - 1];

/** "Tue, 4 Aug 2026": a plain calendar date, unlike formatDateLabel, which speaks in due-date terms ("3d overdue"). */
export function formatPlainDate(dateKey: string): string {
    const civil = civilFromKey(dateKey);
    if (!civil) return dateKey;
    return utcDate(civil).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });
}

export function formatTime(time: string): string {
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
