import { civilFromKey } from "./civil.ts";
import type { EventInput } from "./types.ts";

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Why an event can't be saved, or null if it can. One rule set for the editor and the
 * server, so the form never offers what the API would refuse.
 */
export function eventProblem(e: EventInput): string | null {
    if (!e.title.trim()) return "Add a title";
    if (!civilFromKey(e.startDate) || !civilFromKey(e.endDate)) return "Dates must look like 2026-08-04";
    if (e.endDate < e.startDate) return "The event ends before it starts";

    if ((e.startTime === null) !== (e.endTime === null)) {
        return "Set both times, or neither for an all-day event";
    }
    if (e.startTime !== null && e.endTime !== null) {
        if (!timeRe.test(e.startTime) || !timeRe.test(e.endTime)) return "Times must look like 14:30";
        if (`${e.endDate}T${e.endTime}` <= `${e.startDate}T${e.startTime}`) {
            return "The end must be after the start";
        }
    }
    return null;
}
