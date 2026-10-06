import { describe, expect, it } from "vitest";
import {
    computeStats,
    describeFrequency,
    isDueDay,
    type DayStatus,
    type HabitRule,
} from "../shared/habits.ts";

const daily: HabitRule = { freq: "daily", perWeek: null, weekdays: [] };
const weekly = (n: number): HabitRule => ({ freq: "weekly_count", perWeek: n, weekdays: [] });
const onDays = (...days: number[]): HabitRule => ({ freq: "weekdays", perWeek: null, weekdays: days });

const log = (entries: Record<string, DayStatus>) => new Map(Object.entries(entries));

// 2026-08-03 is a Monday.
describe("daily habits", () => {
    it("counts consecutive done days", () => {
        const s = computeStats(daily, "2026-08-01", log({ "2026-08-01": "done", "2026-08-02": "done", "2026-08-03": "done" }), "2026-08-03");
        expect(s).toMatchObject({ streak: 3, bestStreak: 3, streakUnit: "day", totalDone: 3 });
    });

    it("breaks on a missed day but keeps the best streak", () => {
        const s = computeStats(
            daily,
            "2026-08-01",
            log({ "2026-08-01": "done", "2026-08-02": "done", "2026-08-03": "done", "2026-08-05": "done" }),
            "2026-08-05",
        );
        // Aug 4 was missed, so the run restarts at Aug 5.
        expect(s).toMatchObject({ streak: 1, bestStreak: 3 });
    });

    it("does not break on today while it is still pending", () => {
        const s = computeStats(daily, "2026-08-01", log({ "2026-08-01": "done", "2026-08-02": "done" }), "2026-08-03");
        expect(s.streak).toBe(2);
    });

    it("breaks once the pending day passes unchecked", () => {
        const s = computeStats(daily, "2026-08-01", log({ "2026-08-01": "done", "2026-08-02": "done" }), "2026-08-04");
        expect(s).toMatchObject({ streak: 0, bestStreak: 2 });
    });

    it("treats a skipped day as neutral: it neither extends nor breaks", () => {
        const s = computeStats(
            daily,
            "2026-08-01",
            log({ "2026-08-01": "done", "2026-08-02": "skipped", "2026-08-03": "done" }),
            "2026-08-03",
        );
        expect(s.streak).toBe(2);
    });

    it("has nothing before the start date, or before it starts", () => {
        expect(computeStats(daily, "2026-08-10", log({}), "2026-08-03")).toMatchObject({ streak: 0, rate: null });
    });
});

describe("weekday habits", () => {
    const monWedFri = onDays(1, 3, 5);

    it("only asks for the chosen days, so the others never break a streak", () => {
        const s = computeStats(
            monWedFri,
            "2026-08-03",
            log({ "2026-08-03": "done", "2026-08-05": "done", "2026-08-07": "done" }),
            "2026-08-09",
        );
        expect(s.streak).toBe(3);
    });

    it("breaks on a missed chosen day", () => {
        const s = computeStats(monWedFri, "2026-08-03", log({ "2026-08-03": "done", "2026-08-07": "done" }), "2026-08-08");
        expect(s).toMatchObject({ streak: 1, bestStreak: 1 });
    });

    it("counts a done day that was not due in the total only", () => {
        const s = computeStats(monWedFri, "2026-08-03", log({ "2026-08-04": "done" }), "2026-08-04");
        expect(s).toMatchObject({ streak: 0, totalDone: 1 });
    });

    it("knows which days are due", () => {
        expect(isDueDay(monWedFri, { y: 2026, m: 8, d: 3 })).toBe(true); // Monday
        expect(isDueDay(monWedFri, { y: 2026, m: 8, d: 4 })).toBe(false); // Tuesday
        expect(isDueDay(daily, { y: 2026, m: 8, d: 4 })).toBe(true);
    });
});

describe("N times a week", () => {
    it("counts consecutive weeks that reach the target", () => {
        // Weeks of Aug 3 and Aug 10, three check-ins each; today is in the second.
        const checkins = log({
            "2026-08-03": "done", "2026-08-05": "done", "2026-08-07": "done",
            "2026-08-10": "done", "2026-08-11": "done", "2026-08-13": "done",
        });
        const s = computeStats(weekly(3), "2026-08-03", checkins, "2026-08-13");
        expect(s).toMatchObject({ streak: 2, bestStreak: 2, streakUnit: "week" });
    });

    it("leaves the current week pending until it ends", () => {
        const s = computeStats(weekly(3), "2026-08-03", log({ "2026-08-03": "done", "2026-08-05": "done", "2026-08-07": "done", "2026-08-10": "done" }), "2026-08-12");
        expect(s.streak).toBe(1); // last week met; this week 1 of 3 but not over
    });

    it("breaks on a finished week that fell short, keeping the best streak", () => {
        const checkins = log({
            "2026-08-03": "done", "2026-08-04": "done", "2026-08-05": "done",
            "2026-08-10": "done", // week 2 only reaches 1
            "2026-08-17": "done", "2026-08-18": "done", "2026-08-19": "done",
        });
        const s = computeStats(weekly(3), "2026-08-03", checkins, "2026-08-19");
        expect(s).toMatchObject({ streak: 1, bestStreak: 1 });
        const best = computeStats(weekly(3), "2026-08-03", log({
            "2026-08-03": "done", "2026-08-04": "done", "2026-08-05": "done",
            "2026-08-10": "done", "2026-08-11": "done", "2026-08-12": "done",
            "2026-08-17": "done",
        }), "2026-08-24");
        expect(best).toMatchObject({ streak: 0, bestStreak: 2 });
    });

    it("lowers the target by skipped days, and by days before the habit began", () => {
        // Started Saturday Aug 8: only Sat and Sun are available, so a 3x target is 2.
        const startedLate = computeStats(weekly(3), "2026-08-08", log({ "2026-08-08": "done", "2026-08-09": "done" }), "2026-08-16");
        expect(startedLate.streak).toBe(1);

        // Six days skipped leaves a target of one.
        const skipped = computeStats(
            weekly(3),
            "2026-08-03",
            log({
                "2026-08-03": "skipped", "2026-08-04": "skipped", "2026-08-05": "skipped",
                "2026-08-06": "skipped", "2026-08-07": "skipped", "2026-08-08": "skipped",
                "2026-08-09": "done",
            }),
            "2026-08-10",
        );
        expect(skipped.streak).toBe(1);
    });
});

describe("rate", () => {
    it("is the share of due days done over the last four weeks, ignoring skips and a pending today", () => {
        const s = computeStats(
            daily,
            "2026-08-01",
            log({ "2026-08-01": "done", "2026-08-02": "skipped", "2026-08-03": "done" }),
            "2026-08-05",
        );
        // Due and not skipped: Aug 1, 3, 4 (missed). Aug 5 is pending. 2 of 3.
        expect(s.rate).toBeCloseTo(2 / 3);
    });

    it("is null before anything has been due", () => {
        expect(computeStats(daily, "2026-08-05", log({}), "2026-08-05").rate).toBeNull();
    });

    it("compares weekly habits to their target, capped at it", () => {
        const s = computeStats(
            weekly(2),
            "2026-08-03",
            log({ "2026-08-03": "done", "2026-08-04": "done", "2026-08-05": "done", "2026-08-10": "done" }),
            "2026-08-17",
        );
        // Week 1: 3 done against 2 -> counts 2. Week 2: 1 against 2. Week 3 is current and unmet, so excluded.
        expect(s.rate).toBeCloseTo(3 / 4);
    });
});

describe("describeFrequency", () => {
    it("reads naturally", () => {
        expect(describeFrequency(daily)).toBe("Every day");
        expect(describeFrequency(weekly(1))).toBe("Once a week");
        expect(describeFrequency(weekly(3))).toBe("3 times a week");
        expect(describeFrequency(onDays(1, 2, 3, 4, 5))).toBe("Weekdays");
        expect(describeFrequency(onDays(6, 0))).toBe("Weekends");
        expect(describeFrequency(onDays(5, 1, 3))).toBe("Mon, Wed, Fri");
        expect(describeFrequency(onDays(0, 2))).toBe("Tue, Sun"); // Monday first
    });
});
