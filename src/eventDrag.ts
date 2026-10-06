import { addDays, civilFromKey, civilKey, minutesToTime } from "../shared/civil.ts";
import type { EventInput } from "../shared/types.ts";

/** Pressing and dragging on the calendar snaps to this many minutes. */
export const SNAP_MINUTES = 15;
/** A plain click, with no drag, makes an event this long. */
export const CLICK_MINUTES = 60;
const DAY_MINUTES = 1440;

/** Minutes into the day for a pointer `offsetPx` below the top of a day column. */
export function minutesAtOffset(offsetPx: number, hourPx: number): number {
    return Math.min(DAY_MINUTES, Math.max(0, (offsetPx / hourPx) * 60));
}

const slotStart = (minutes: number) =>
    Math.min(DAY_MINUTES - SNAP_MINUTES, Math.floor(minutes / SNAP_MINUTES) * SNAP_MINUTES);

/**
 * The block drawn by pressing at `anchor` and dragging to `current` (both minutes into
 * the day). It always covers the slot that was pressed and the slot under the pointer,
 * so dragging up or down grows it from the press point. With no movement it is a
 * default-length block starting at the pressed slot, like clicking in Google Calendar.
 */
export function dragRange(anchor: number, current: number, moved: boolean): { start: number; end: number } {
    const a = slotStart(anchor);
    if (!moved) return { start: a, end: Math.min(DAY_MINUTES, a + CLICK_MINUTES) };

    const c = slotStart(current);
    return { start: Math.min(a, c), end: Math.max(a, c) + SNAP_MINUTES };
}

/**
 * Turns a dragged range into the event fields. A block that runs to the end of the day
 * ends at midnight, which is 00:00 on the next date.
 */
export function rangeToEvent(dayKey: string, start: number, end: number): EventInput {
    const day = civilFromKey(dayKey);
    const endsAtMidnight = end >= DAY_MINUTES;
    const endDay = day && endsAtMidnight ? civilKey(addDays(day, 1)) : dayKey;
    return {
        title: "",
        description: "",
        startDate: dayKey,
        startTime: minutesToTime(start),
        endDate: endDay,
        endTime: endsAtMidnight ? "00:00" : minutesToTime(end),
    };
}
