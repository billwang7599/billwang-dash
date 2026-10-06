import { civilFromKey, diffDays } from "../shared/civil.ts";
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
