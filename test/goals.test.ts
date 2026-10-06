import { describe, expect, it } from "vitest";
import { daysLeft, goalInputSchema, horizonFor, horizonMismatch, isDone, progress } from "../shared/goals.ts";

const base = { title: "Read 12 books", horizon: "short", target: 12, deadline: "2026-12-31" };

describe("progress", () => {
    it("is current over target, clamped to 0..1", () => {
        expect(progress({ current: 3, target: 12 })).toBe(0.25);
        expect(progress({ current: 20, target: 12 })).toBe(1);
        expect(progress({ current: 0, target: 5 })).toBe(0);
    });

    it("treats a goal with no target as yes/no", () => {
        expect(progress({ current: 0, target: null })).toBe(0);
        expect(progress({ current: 1, target: null })).toBe(1);
        expect(isDone({ current: 0, target: null })).toBe(false);
        expect(isDone({ current: 1, target: null })).toBe(true);
    });

    it("is done once current reaches target", () => {
        expect(isDone({ current: 11.9, target: 12 })).toBe(false);
        expect(isDone({ current: 12, target: 12 })).toBe(true);
    });
});

describe("horizons", () => {
    const today = "2026-10-06";

    it("splits at 3 and 12 months", () => {
        expect(horizonFor(today, "2026-10-01")).toBe("short"); // already past
        expect(horizonFor(today, "2027-01-05")).toBe("short");
        expect(horizonFor(today, "2027-01-06")).toBe("medium");
        expect(horizonFor(today, "2027-10-05")).toBe("medium");
        expect(horizonFor(today, "2027-10-06")).toBe("long");
    });

    it("warns only when the deadline suggests another horizon", () => {
        expect(horizonMismatch("short", today, "2026-11-01")).toBeNull();
        expect(horizonMismatch("short", today, "2027-04-01")).toMatch(/medium term/);
        expect(horizonMismatch("long", today, "2026-11-01")).toMatch(/short term/);
        expect(horizonMismatch("short", today, "not a date")).toBeNull();
    });

    it("counts days left, negative once overdue", () => {
        expect(daysLeft(today, "2026-10-16")).toBe(10);
        expect(daysLeft(today, "2026-10-01")).toBe(-5);
    });
});

describe("goalInputSchema", () => {
    it("fills defaults and trims", () => {
        expect(goalInputSchema.parse({ ...base, why: "  for fun ", unit: " books " })).toEqual({
            ...base,
            why: "for fun",
            unit: "books",
            current: 0,
        });
    });

    it("allows no target, which makes a yes/no goal", () => {
        const { target: _, ...noTarget } = base;
        expect(goalInputSchema.parse(noTarget).target).toBeNull();
        expect(goalInputSchema.parse({ ...base, target: null }).target).toBeNull();
    });

    it("rejects an empty title, a target of 0 or less, a bad date, and an unknown horizon", () => {
        expect(goalInputSchema.safeParse({ ...base, title: "  " }).success).toBe(false);
        expect(goalInputSchema.safeParse({ ...base, target: 0 }).success).toBe(false);
        expect(goalInputSchema.safeParse({ ...base, target: -1 }).success).toBe(false);
        expect(goalInputSchema.safeParse({ ...base, deadline: "2026-02-31" }).success).toBe(false);
        expect(goalInputSchema.safeParse({ ...base, horizon: "someday" }).success).toBe(false);
        expect(goalInputSchema.safeParse({ ...base, current: -1 }).success).toBe(false);
    });
});
