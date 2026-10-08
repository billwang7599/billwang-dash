import { addDays, civilFromDate, civilFromKey, civilKey, diffDays } from "../shared/civil.ts";
import { DAYS, formatPlainDate, formatRecurrence, formatTime, utcDate } from "../shared/format.ts";
import type { DueDate } from "../shared/types.ts";

// Moved to shared/ so the server can word the assistant's approval cards the same way.
export { formatPlainDate, formatRecurrence, formatTime, priorityName } from "../shared/format.ts";

/** The browser's own IANA zone. */
export const deviceTimeZone = (): string =>
    Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Resolves aliases ("Asia/Calcutta" vs "Asia/Kolkata") so equal zones compare equal. */
export function canonicalTimeZone(tz: string): string {
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
        return tz;
    }
}

/** Every zone the browser knows, plus any that must be present (browsers omit "UTC"). */
export function timeZoneList(extra: string[]): string[] {
    const known = Intl.supportedValuesOf?.("timeZone") ?? [];
    return [...new Set([...extra, "UTC", ...known])].sort();
}

export const todayKey = (timeZone: string) =>
    civilKey(civilFromDate(new Date(), timeZone));

export const formatInstant = (iso: string, timeZone: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", timeZone });

/** "Today", "Tomorrow", "Sat 8 Aug" — plus time and repeat rule if set. */
export function formatDueLabel(due: DueDate, timeZone: string): string {
    const parts = [formatDateLabel(due.date, timeZone)];
    if (due.time) parts.push(formatTime(due.time));
    if (due.recurrence) parts.push(formatRecurrence(due.recurrence));
    return parts.join(" · ");
}

/**
 * "Tue, 4 Aug 2026 · 10:00–11:00", "… · All day", or "Tue, 4 Aug 2026 – Thu, 6 Aug 2026".
 * An all-day event's bounds are bare dates that the server stored as UTC midnight,
 * so they are read as dates, never shifted into the user's zone.
 */
export function formatEventWhen(
    item: { start: string; end: string; allDay: boolean },
    timeZone: string,
): string {
    if (item.allDay) {
        const first = item.start.slice(0, 10);
        const endExclusive = civilFromKey(item.end.slice(0, 10));
        const last = endExclusive ? civilKey(addDays(endExclusive, -1)) : first;
        return last > first
            ? `${formatPlainDate(first)} – ${formatPlainDate(last)}`
            : `${formatPlainDate(first)} · All day`;
    }
    const day = civilKey(civilFromDate(new Date(item.start), timeZone));
    return `${formatPlainDate(day)} · ${formatInstant(item.start, timeZone)}–${formatInstant(item.end, timeZone)}`;
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
