import { civilFromDate, civilFromKey, civilKey, parseTimeToMinutes, zonedToUtcMs } from "../../shared/civil.ts";

/** Timestamps are stored as epoch milliseconds and sent to clients as ISO strings. */

/** An ISO string as epoch ms; null stays null, and "" (unknown) or garbage is 0. */
export function toMs(iso: string | null | undefined): number | null {
    if (iso === null || iso === undefined) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
}

/** Epoch ms as an ISO string. 0 is "created before this was recorded", which clients know as "". */
export const toIso = (ms: number): string => (ms === 0 ? "" : new Date(ms).toISOString());

/** Like toIso, for a column that may be null. */
export const toIsoOrNull = (ms: number | null): string | null => (ms === null ? null : toIso(ms));

/** What a date with no time of day means: the last minute of that day. */
export const END_OF_DAY_MINUTES = 23 * 60 + 59;

/** The moment a date (and optional time) means in `zone`; no time is the end of the day. */
export function instantOf(date: string, time: string | null, zone: string): number {
    const civil = civilFromKey(date);
    if (!civil) throw new Error(`bad date: ${date}`);
    return zonedToUtcMs(civil, time ? parseTimeToMinutes(time) : END_OF_DAY_MINUTES, zone);
}

/** What a stored moment is pinned to: epoch ms, the zone it was set in, and whether it has a time. */
export interface Pinned {
    at: number | null;
    tz: string | null;
    hasTime: boolean;
}

/**
 * The instant and zone to store for a date and time the client sent, read in `zone` (the
 * user's current one). A form saved without touching its date sends back what the stored
 * moment looks like from here; that keeps its original zone, rather than re-pinning to
 * wherever the user is now.
 */
export function resolveInstant(
    date: string | null,
    time: string | null,
    zone: string,
    was: Pinned | null,
): { at: number | null; tz: string | null } {
    if (date === null) return { at: null, tz: null };
    if (was?.at != null) {
        const unchanged = time
            ? was.hasTime && instantOf(date, time, zone) === was.at
            : !was.hasTime && civilKey(civilFromDate(new Date(was.at), zone)) === date;
        if (unchanged) return { at: was.at, tz: was.tz ?? zone };
    }
    return { at: instantOf(date, time, zone), tz: zone };
}
