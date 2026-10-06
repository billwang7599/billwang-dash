import { addDays, civilFromKey, civilKey, diffDays, weekday, type Civil } from "./civil.ts";

/**
 * Habit rules and statistics, as pure functions: the Worker computes the numbers
 * and the UI formats them, and tests can pin the streak rules without storage.
 *
 * A day is "done", "skipped" (excused: neither extends nor breaks a streak), or
 * has no check-in. A past due day with no check-in is missed. Today without one is
 * still pending, so it never breaks a streak. Weeks run Monday to Sunday.
 */

export type HabitFreq = "daily" | "weekly_count" | "weekdays";
export type DayStatus = "done" | "skipped";

export interface HabitRule {
    freq: HabitFreq;
    /** weekly_count: how many days a week, 1 to 7. */
    perWeek: number | null;
    /** weekdays: which days count, 0 = Sunday ... 6 = Saturday. */
    weekdays: number[];
}

export interface HabitStats {
    /** Consecutive due days (or, for "N times a week", weeks) met. */
    streak: number;
    bestStreak: number;
    streakUnit: "day" | "week";
    /** Every day ever checked off, including days that were not due. */
    totalDone: number;
    /** Share of the last four weeks met, 0 to 1, or null with nothing due yet. */
    rate: number | null;
}

/** What a create or edit sends: a name and a rule. */
export interface HabitInput extends HabitRule {
    name: string;
}

export interface Habit extends HabitRule {
    id: string;
    name: string;
    order: number;
    createdAt: string;
    /** First day that counts, YYYY-MM-DD. Moves back if an earlier day is logged. */
    startDate: string;
}

export interface HabitSummary extends Habit {
    stats: HabitStats;
    /** Today's check-in, if any. */
    today: DayStatus | null;
}

export interface HabitDay {
    day: string;
    status: DayStatus;
    note: string;
}

export interface HabitDetail {
    habit: HabitSummary;
    /** YYYY-MM */
    month: string;
    days: HabitDay[];
}

const RATE_DAYS = 28;
const RATE_WEEKS = 4;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Whether a calendar day is one the habit asks for. "N times a week" accepts any day. */
export function isDueDay(rule: HabitRule, day: Civil): boolean {
    if (rule.freq === "weekdays") return rule.weekdays.includes(weekday(day));
    return true;
}

export function describeFrequency(rule: HabitRule): string {
    if (rule.freq === "daily") return "Every day";
    if (rule.freq === "weekly_count") {
        const n = rule.perWeek ?? 1;
        return n === 1 ? "Once a week" : `${n} times a week`;
    }
    const days = [...rule.weekdays].sort((a, b) => a - b);
    if (days.join() === "1,2,3,4,5") return "Weekdays";
    if (days.join() === "0,6") return "Weekends";
    // Monday first, to match the calendar.
    return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAY_NAMES[d]).join(", ");
}

const monday = (c: Civil): Civil => addDays(c, -((weekday(c) + 6) % 7));

export function computeStats(
    rule: HabitRule,
    startDate: string,
    checkins: ReadonlyMap<string, DayStatus>,
    today: string,
): HabitStats {
    let totalDone = 0;
    for (const status of checkins.values()) if (status === "done") totalDone++;

    const streakUnit = rule.freq === "weekly_count" ? "week" : "day";
    const start = civilFromKey(startDate);
    const now = civilFromKey(today);
    if (!start || !now || diffDays(start, now) < 0) {
        return { streak: 0, bestStreak: 0, streakUnit, totalDone, rate: null };
    }

    const result =
        rule.freq === "weekly_count"
            ? weeklyRun(rule.perWeek ?? 1, start, now, checkins)
            : dailyRun(rule, start, now, checkins);
    return { ...result, streakUnit, totalDone };
}

type Run = Pick<HabitStats, "streak" | "bestStreak" | "rate">;

/** Daily and weekday habits: every due day counts. */
function dailyRun(
    rule: HabitRule,
    start: Civil,
    now: Civil,
    checkins: ReadonlyMap<string, DayStatus>,
): Run {
    const span = diffDays(start, now);
    let run = 0;
    let best = 0;
    let due = 0;
    let done = 0;

    for (let i = 0; i <= span; i++) {
        const day = addDays(start, i);
        if (!isDueDay(rule, day)) continue;

        const status = checkins.get(civilKey(day));
        const isToday = i === span;

        if (status === "done") {
            run++;
            best = Math.max(best, run);
        } else if (status !== "skipped" && !isToday) {
            run = 0; // a past due day with nothing logged
        }

        if (span - i < RATE_DAYS) {
            if (status === "done") {
                due++;
                done++;
            } else if (status !== "skipped" && !isToday) {
                due++;
            }
        }
    }

    return { streak: run, bestStreak: best, rate: due > 0 ? done / due : null };
}

/**
 * "N times a week": each week is met or not. A skipped day comes off the week's
 * target, and so do days before the habit started. The current week never breaks
 * a streak until it is over.
 */
function weeklyRun(
    perWeek: number,
    start: Civil,
    now: Civil,
    checkins: ReadonlyMap<string, DayStatus>,
): Run {
    const firstMonday = monday(start);
    const lastWeek = diffDays(firstMonday, monday(now)) / 7;
    let run = 0;
    let best = 0;
    let met = 0;
    let target = 0;

    for (let w = 0; w <= lastWeek; w++) {
        const weekStart = addDays(firstMonday, 7 * w);
        let available = 0;
        let skipped = 0;
        let done = 0;
        for (let d = 0; d < 7; d++) {
            const day = addDays(weekStart, d);
            if (diffDays(start, day) < 0) continue;
            available++;
            const status = checkins.get(civilKey(day));
            if (status === "skipped") skipped++;
            else if (status === "done") done++;
        }

        const required = Math.min(perWeek, available - skipped);
        if (required <= 0) continue;

        const isCurrent = w === lastWeek;
        const isMet = done >= required;
        if (isMet) {
            run++;
            best = Math.max(best, run);
        } else if (!isCurrent) {
            run = 0;
        }

        if (lastWeek - w < RATE_WEEKS && (isMet || !isCurrent)) {
            met += Math.min(done, required);
            target += required;
        }
    }

    return { streak: run, bestStreak: best, rate: target > 0 ? met / target : null };
}
