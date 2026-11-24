import type { DueDate } from "../shared/types.ts";
import { parseQuickAdd } from "../shared/parser.ts";
import { addDays, civilFromDate, civilKey, nextWeekday, weekday } from "../shared/civil.ts";

export type FinishByPick = "today" | "tomorrow" | "weekend" | "nextWeek";

export const FINISH_BY_PICKS: readonly [FinishByPick, string][] = [
    ["today", "Today"],
    ["tomorrow", "Tomorrow"],
    ["weekend", "This weekend"],
    ["nextWeek", "Next week"],
];

/**
 * The dates behind the editor's quick picks, as YYYY-MM-DD in the user's zone
 * (not the device's, and never UTC). Matches the quick-add parser: "next week" is
 * the coming Monday and "this weekend" is Saturday, except that on Sunday the
 * weekend is still today rather than six days away.
 */
export function finishByDates(now: Date, timeZone: string): Record<FinishByPick, string> {
    const today = civilFromDate(now, timeZone);
    const weekend = weekday(today) === 0 ? today : nextWeekday(today, 6, true);
    return {
        today: civilKey(today),
        tomorrow: civilKey(addDays(today, 1)),
        weekend: civilKey(weekend),
        nextWeek: civilKey(nextWeekday(today, 1, false)),
    };
}

/**
 * Typed text in the Finish by field ("fri", "in 3 days", "dec 5 5pm", "every monday"),
 * read by the quick-add parser so both understand the same words. Only text that is
 * entirely a date (an optional leading "by"/"on"/"due" aside) counts; anything else,
 * like "fri lunch", returns null so a typo never moves the task.
 */
export function parseFinishBy(
    text: string,
    opts: { now?: Date; timeZone: string; dateFormat?: "MDY" | "DMY" },
): DueDate | null {
    const trimmed = text.trim().replace(/^(?:by|on|due|until)\s+/i, "");
    if (!trimmed) return null;
    const parsed = parseQuickAdd(trimmed, opts);
    if (!parsed.due || parsed.content.trim() !== "") return null;
    // A priority, #project, {deadline} or duration means this wasn't just a date.
    if (parsed.projectName || parsed.priority !== 4 || parsed.deadline || parsed.durationMinutes) return null;
    return parsed.due;
}
