import { beforeEach, describe, expect, it } from "vitest";
import type { CalendarItem } from "../shared/types.ts";
import { clearCalendarCache, getCachedRange, rangeCacheKey, setCachedRange } from "../src/calendarCache.ts";

const item = (id: string): CalendarItem => ({
    id,
    kind: "gcal",
    title: id,
    start: "2026-08-04T10:00:00.000Z",
    end: "2026-08-04T11:00:00.000Z",
    allDay: false,
});

describe("calendar range cache", () => {
    beforeEach(clearCalendarCache);

    it("returns what was stored for the same range and stamp", () => {
        setCachedRange("a", "1:0", [item("x")]);
        expect(getCachedRange("a", "1:0")?.[0].id).toBe("x");
        expect(getCachedRange("b", "1:0")).toBeUndefined();
    });

    it("ignores, then evicts, entries from an older stamp", () => {
        setCachedRange("a", "1:0", [item("x")]);
        expect(getCachedRange("a", "1:1")).toBeUndefined();
        setCachedRange("b", "1:1", [item("y")]);
        expect(getCachedRange("a", "1:0")).toBeUndefined();
    });

    it("keys by timezone as well as range", () => {
        const range = ["2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z"] as const;
        expect(rangeCacheKey("UTC", ...range)).not.toBe(rangeCacheKey("Asia/Tokyo", ...range));
    });

    it("drops the oldest entries past its cap", () => {
        for (let i = 0; i < 30; i++) setCachedRange(`k${i}`, "s", [item(`${i}`)]);
        expect(getCachedRange("k0", "s")).toBeUndefined();
        expect(getCachedRange("k29", "s")).toBeDefined();
    });
});
