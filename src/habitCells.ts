import { addDays, civilFromKey, civilKey, diffDays, weekday } from "../shared/civil.ts";
import { isDueDay, type DayStatus, type HabitSummary } from "../shared/habits.ts";

/**
 * The CSS state of one day's cell for a habit, shared by the habit page's month
 * grid and the all-habits grid so both read the same way.
 */
export function cellState(
    habit: HabitSummary,
    key: string,
    status: DayStatus | undefined,
    today: string,
): string {
    if (status) return status === "done" ? "is-done" : "is-skipped";
    if (key > today) return "is-future";
    const start = civilFromKey(habit.startDate);
    const c = civilFromKey(key);
    const countable = c && start && diffDays(start, c) >= 0 && isDueDay(habit, c);
    if (!countable) return "is-off";
    if (key === today) return "is-pending";
    // "N times a week" is judged by the week, not the day: an unchecked day
    // isn't a miss on its own, so it reads as neutral rather than red.
    return habit.freq === "weekly_count" ? "is-off" : "is-missed";
}

// A skip excuses the day; a check-off on a rest day still counts. A past day is
// judged as it stood that day, so its unchecked habits read as due, not missed.
export function dayTally(
    habits: HabitSummary[],
    day: string,
    statusOf: (habit: HabitSummary) => DayStatus | undefined,
): { done: number; due: number } {
    let done = 0;
    let due = 0;
    for (const h of habits) {
        const state = cellState(h, day, statusOf(h), day);
        if (state === "is-done") done++;
        if (state === "is-done" || state === "is-pending") due++;
    }
    return { done, due };
}

/** The Monday-to-Sunday week holding `day`, as YYYY-MM-DD keys. */
export function weekOf(day: string): string[] {
    const d = civilFromKey(day)!;
    const mondayOffset = (weekday(d) + 6) % 7;
    return Array.from({ length: 7 }, (_, i) => civilKey(addDays(d, i - mondayOffset)));
}

/** "YYYY-MM" moved by `by` months. */
export function shiftMonth(month: string, by: number): string {
    const [y, m] = month.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1 + by, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The day a week step lands on: a week away, but never past today. */
export function stepWeek(day: string, by: number, today: string): string {
    const next = civilKey(addDays(civilFromKey(day)!, by * 7));
    return next > today ? today : next;
}
