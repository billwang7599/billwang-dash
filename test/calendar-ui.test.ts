import { describe, expect, it } from "vitest";
import type { CalendarItem } from "../shared/types.ts";
import { layoutEvents } from "../src/eventLayout.ts";
import { formatEventWhen } from "../src/format.ts";

const ev = (id: string, from: string, to: string): CalendarItem => ({
    id,
    kind: "gcal",
    title: id,
    start: `2026-08-04T${from}:00.000Z`,
    end: `2026-08-04T${to}:00.000Z`,
    allDay: false,
});

const byId = (items: CalendarItem[]) =>
    Object.fromEntries(layoutEvents(items).map((p) => [p.item.id, p]));

describe("layoutEvents", () => {
    it("gives a lone event the full width, even when the rest of the day is crowded", () => {
        const placed = byId([
            ev("early", "07:00", "09:00"),
            ev("a", "14:00", "15:00"),
            ev("b", "14:30", "15:30"),
            ev("c", "14:45", "16:00"),
        ]);
        expect(placed.early).toMatchObject({ column: 0, columns: 1, span: 1 });
        expect(placed.c.columns).toBe(3);
    });

    it("puts overlapping events in separate lanes", () => {
        const placed = byId([ev("a", "10:00", "11:00"), ev("b", "10:30", "11:30")]);
        expect(placed.a).toMatchObject({ column: 0, columns: 2 });
        expect(placed.b).toMatchObject({ column: 1, columns: 2 });
    });

    it("treats a chain of overlaps as one cluster", () => {
        const placed = byId([ev("a", "09:00", "10:00"), ev("b", "09:30", "10:30"), ev("c", "10:15", "11:00")]);
        expect(new Set(Object.values(placed).map((p) => p.columns))).toEqual(new Set([2]));
        expect(placed.c.column).toBe(0); // a has finished, so lane 0 is free again
    });

    it("lets events that merely touch share a lane", () => {
        const placed = byId([ev("a", "09:00", "10:00"), ev("b", "10:00", "11:00")]);
        expect(placed.a.columns).toBe(1);
        expect(placed.b.columns).toBe(1);
    });

    it("stretches an event across lanes that stay free for its whole duration", () => {
        const placed = byId([
            ev("p", "09:00", "12:00"), // lane 0
            ev("q", "09:00", "10:00"), // lane 1, and lane 2 is empty while it runs
            ev("r", "10:00", "11:00"), // lane 1
            ev("s", "10:30", "12:00"), // lane 2: overlaps r, so r can't stretch
        ]);
        expect(placed.q).toMatchObject({ column: 1, columns: 3, span: 2 });
        expect(placed.r.span).toBe(1);
        expect(placed.p.span).toBe(1);
        expect(placed.s.span).toBe(1);
    });

    it("handles no events", () => {
        expect(layoutEvents([])).toEqual([]);
    });
});

describe("formatEventWhen", () => {
    it("shows a timed event's range in the given zone", () => {
        const item = ev("a", "15:00", "16:30");
        expect(formatEventWhen(item, "UTC")).toBe("Tue, 4 Aug 2026 \u00b7 15:00\u201316:30");
        expect(formatEventWhen(item, "America/Chicago")).toBe("Tue, 4 Aug 2026 \u00b7 10:00\u201311:30");
    });

    it("never labels a past event as overdue", () => {
        expect(formatEventWhen(ev("old", "09:00", "10:00"), "UTC")).not.toMatch(/overdue|Yesterday|Today/);
    });

    it("reads an all-day event as dates, not shifted by the zone", () => {
        const oneDay = { start: "2026-08-04T00:00:00.000Z", end: "2026-08-05T00:00:00.000Z", allDay: true };
        expect(formatEventWhen(oneDay, "Pacific/Auckland")).toBe("Tue, 4 Aug 2026 \u00b7 All day");
        expect(formatEventWhen(oneDay, "America/Los_Angeles")).toBe("Tue, 4 Aug 2026 \u00b7 All day");
    });

    it("shows a multi-day all-day event as an inclusive range", () => {
        const trip = { start: "2026-08-04T00:00:00.000Z", end: "2026-08-07T00:00:00.000Z", allDay: true };
        expect(formatEventWhen(trip, "UTC")).toBe("Tue, 4 Aug 2026 \u2013 Thu, 6 Aug 2026");
    });
});
