import { describe, expect, it } from "vitest";
import { CLICK_MINUTES, dragRange, minutesAtOffset, rangeToEvent } from "../src/eventDrag.ts";

const at = (h: number, m = 0) => h * 60 + m;

describe("minutesAtOffset", () => {
    it("converts pixels to minutes and clamps to the day", () => {
        expect(minutesAtOffset(46, 46)).toBe(60);
        expect(minutesAtOffset(23, 46)).toBe(30);
        expect(minutesAtOffset(-10, 46)).toBe(0);
        expect(minutesAtOffset(46 * 30, 46)).toBe(1440);
    });
});

describe("dragRange", () => {
    it("makes a default-length block from a plain click, at the pressed slot", () => {
        expect(dragRange(at(10, 7), at(10, 7), false)).toEqual({ start: at(10), end: at(10) + CLICK_MINUTES });
        expect(dragRange(at(10, 20), at(10, 20), false)).toEqual({ start: at(10, 15), end: at(11, 15) });
    });

    it("stops a click near midnight at the end of the day", () => {
        expect(dragRange(at(23, 40), at(23, 40), false)).toEqual({ start: at(23, 30), end: 1440 });
    });

    it("covers the pressed slot and the slot under the pointer when dragging down", () => {
        expect(dragRange(at(9), at(10, 40), true)).toEqual({ start: at(9), end: at(10, 45) });
    });

    it("grows from the press point when dragging up", () => {
        expect(dragRange(at(10, 20), at(9), true)).toEqual({ start: at(9), end: at(10, 30) });
    });

    it("is one slot when the drag stays inside the pressed slot", () => {
        expect(dragRange(at(10, 2), at(10, 11), true)).toEqual({ start: at(10), end: at(10, 15) });
    });

    it("never runs past the end of the day", () => {
        expect(dragRange(at(23), 1440, true).end).toBe(1440);
        expect(dragRange(at(23), 5000, true).end).toBe(1440);
    });
});

describe("rangeToEvent", () => {
    it("fills the date and times of a same-day block", () => {
        expect(rangeToEvent("2026-08-04", at(9, 30), at(11))).toMatchObject({
            startDate: "2026-08-04", startTime: "09:30", endDate: "2026-08-04", endTime: "11:00",
        });
    });

    it("ends a block that reaches the end of the day at 00:00 the next date", () => {
        expect(rangeToEvent("2026-08-31", at(23), 1440)).toMatchObject({
            startDate: "2026-08-31", startTime: "23:00", endDate: "2026-09-01", endTime: "00:00",
        });
    });
});
