import { describe, expect, it } from "vitest";
import { finishByDates, parseFinishBy } from "../src/finishBy.ts";

const TZ = "America/Chicago";

describe("finish-by quick picks", () => {
    it("counts from a weekday", () => {
        // Monday 2026-08-03, 10:00 Chicago.
        expect(finishByDates(new Date("2026-08-03T15:00:00Z"), TZ)).toEqual({
            today: "2026-08-03",
            tomorrow: "2026-08-04",
            weekend: "2026-08-08",
            nextWeek: "2026-08-10",
        });
    });

    it("uses the user's zone, not UTC, late in the evening", () => {
        // 03:30 UTC on Tuesday is still Monday 22:30 in Chicago.
        const picks = finishByDates(new Date("2026-08-04T03:30:00Z"), TZ);
        expect(picks.today).toBe("2026-08-03");
        expect(picks.tomorrow).toBe("2026-08-04");
    });

    it("keeps Saturday and Sunday as this weekend", () => {
        expect(finishByDates(new Date("2026-08-08T15:00:00Z"), TZ).weekend).toBe("2026-08-08");
        expect(finishByDates(new Date("2026-08-09T15:00:00Z"), TZ).weekend).toBe("2026-08-09");
    });

    it("never makes next week today, even on a Monday or a Sunday", () => {
        expect(finishByDates(new Date("2026-08-03T15:00:00Z"), TZ).nextWeek).toBe("2026-08-10");
        expect(finishByDates(new Date("2026-08-09T15:00:00Z"), TZ).nextWeek).toBe("2026-08-10");
    });

    it("crosses a month end", () => {
        // Friday 2026-07-31.
        expect(finishByDates(new Date("2026-07-31T15:00:00Z"), TZ)).toEqual({
            today: "2026-07-31",
            tomorrow: "2026-08-01",
            weekend: "2026-08-01",
            nextWeek: "2026-08-03",
        });
    });
});

describe("typed finish-by text", () => {
    // Monday 2026-08-03, 10:00 Chicago.
    const now = new Date("2026-08-03T15:00:00Z");
    const parse = (text: string, at = now) => parseFinishBy(text, { now: at, timeZone: TZ });

    it("reads the words quick-add reads", () => {
        expect(parse("fri")).toEqual({ date: "2026-08-07", time: null, recurrence: null });
        // Same reading as quick-add: "next tuesday" is the coming Tuesday.
        expect(parse("next tuesday")?.date).toBe("2026-08-04");
        expect(parse("in 3 days")?.date).toBe("2026-08-06");
        expect(parse("dec 5")?.date).toBe("2026-12-05");
        expect(parse("by friday")?.date).toBe("2026-08-07");
    });

    it("carries a time and a repeat", () => {
        expect(parse("tomorrow 5pm")).toEqual({ date: "2026-08-04", time: "17:00", recurrence: null });
        const every = parse("every monday");
        expect(every?.recurrence?.freq).toBe("weekly");
        expect(every?.date).toBe("2026-08-03");
    });

    it("counts from the user's day, not UTC's", () => {
        // 03:30 UTC Tuesday is Monday evening in Chicago, so "tomorrow" is Tuesday.
        expect(parse("tomorrow", new Date("2026-08-04T03:30:00Z"))?.date).toBe("2026-08-04");
        // ...and in Tokyo the same instant is already Tuesday noon.
        expect(parseFinishBy("tomorrow", { now: new Date("2026-08-04T03:30:00Z"), timeZone: "Asia/Tokyo" })?.date)
            .toBe("2026-08-05");
    });

    it("follows the day/month order preference", () => {
        expect(parseFinishBy("3/4", { now, timeZone: TZ, dateFormat: "MDY" })?.date).toBe("2027-03-04");
        expect(parseFinishBy("3/4", { now, timeZone: TZ, dateFormat: "DMY" })?.date).toBe("2027-04-03");
    });

    it("rejects anything that isn't purely a date", () => {
        expect(parse("")).toBeNull();
        expect(parse("   ")).toBeNull();
        expect(parse("soonish")).toBeNull();
        expect(parse("fri lunch")).toBeNull();
        expect(parse("fri p1")).toBeNull();
        expect(parse("fri #work")).toBeNull();
    });
});
