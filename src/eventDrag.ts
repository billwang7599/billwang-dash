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

/** How long a finger rests on the calendar before it picks up an event or starts drawing one, in ms. */
export const LONG_PRESS_MS = 400;

/**
 * Pixels per frame to scroll the grid while dragging with the pointer at `y`, for a grid
 * spanning `top` to `bottom` on screen: none in the middle, faster the deeper into the band
 * along either edge, and full speed past it. Negative scrolls up.
 */
export function edgeScrollSpeed(y: number, top: number, bottom: number, band = 36, max = 14): number {
    if (y < top + band) return -Math.ceil(max * Math.min(1, (top + band - y) / band));
    if (y > bottom - band) return Math.ceil(max * Math.min(1, (y - bottom + band) / band));
    return 0;
}

/** Where a resized event ends: the bottom of the slot under the pointer (minutes into the day). */
export function resizedEndMinutes(current: number): number {
    return Math.min(DAY_MINUTES, slotStart(current) + SNAP_MINUTES);
}

/** Where a resized event starts: the top of the slot under the pointer (minutes into the day). */
export function resizedStartMinutes(current: number): number {
    return slotStart(current);
}

/** How far a dragged event has moved, in minutes: the pointer's travel, rounded to whole slots. */
export function movedMinutes(anchor: number, current: number): number {
    return Math.round((current - anchor) / SNAP_MINUTES) * SNAP_MINUTES;
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
