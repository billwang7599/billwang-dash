import { addDays, civilFromKey, civilKey, diffDays, type Civil } from "../../shared/civil.ts";
import type { GoogleEvent } from "../google.ts";

/**
 * A per-day cache of the user's Google events. Plain functions over the DO's SQL
 * handle; GoogleSync decides when to fetch and calls these to read and write.
 *
 * Each calendar's day is fetched on its own clock, so looking at today never fetches
 * next week. How long a day stays fresh depends on when it is:
 * - past days: until a manual sync (the past rarely changes),
 * - today: six hours,
 * - later days: doubling with distance (tomorrow 12h, then 24h, 48h, ...), at most a week.
 */

const HOUR = 3_600_000;
export const TODAY_TTL_MS = 6 * HOUR;
const MAX_TTL_MS = 7 * 24 * HOUR;

/** How long a day `distance` days after today stays fresh: 6h doubled per day out, capped. */
export function futureTtlMs(distance: number): number {
    return Math.min(TODAY_TTL_MS * 2 ** distance, MAX_TTL_MS);
}
/** Cached days (and their events) further back than this are dropped. */
const KEEP_PAST_DAYS = 31;

/** Whether a day fetched at `syncedAt` still counts as fresh at `now`. */
export function isFresh(day: string, today: string, syncedAt: number, now: number): boolean {
    if (day < today) return true;
    const distance = day === today ? 0 : diffDays(civilFromKey(today)!, civilFromKey(day)!);
    return now - syncedAt < futureTtlMs(distance);
}

/** The days in a window that need fetching for one calendar. */
export function staleDays(sql: SqlStorage, calendarId: string, days: string[], today: string, now: number): string[] {
    if (days.length === 0) return [];
    const synced = new Map(
        sql
            .exec<{ day: string; synced_at: number }>(
                "SELECT day, synced_at FROM gcal_cache_days WHERE calendar_id = ? AND day >= ? AND day <= ?",
                calendarId, days[0], days[days.length - 1],
            )
            .toArray()
            .map((r) => [r.day, r.synced_at]),
    );
    return days.filter((d) => {
        const at = synced.get(d);
        return at === undefined || !isFresh(d, today, at, now);
    });
}

/** Consecutive days as [first, last] runs, so each run is one Google request. */
export function runs(days: string[]): [string, string][] {
    const out: [string, string][] = [];
    for (const d of days) {
        const last = out[out.length - 1];
        if (last && civilKey(addDays(civilFromKey(last[1])!, 1)) === d) last[1] = d;
        else out.push([d, d]);
    }
    return out;
}

/**
 * Whether an event touches the days first..last. All-day events are dates, so they
 * are compared as dates; timed ones as instants against the days' zoned bounds.
 */
const overlapSql = `
    calendar_id = ? AND (
        (all_day = 1 AND substr(start, 1, 10) <= ? AND substr(end, 1, 10) > ?)
        OR (all_day = 0 AND start < ? AND end > ?)
    )`;

/**
 * Stores what Google returned for days first..last (instants fromISO..toISO): every
 * cached event touching those days is replaced, so one deleted in Google disappears.
 */
export function replaceDays(
    sql: SqlStorage,
    calendarId: string,
    first: string,
    last: string,
    fromISO: string,
    toISO: string,
    events: GoogleEvent[],
    now: number,
): void {
    sql.exec(`DELETE FROM gcal_cache_events WHERE ${overlapSql}`, calendarId, last, first, toISO, fromISO);
    for (const e of events) {
        // Events dash wrote are the tasks themselves, already shown as tasks.
        if (e.dashTaskId) continue;
        sql.exec(
            `INSERT OR REPLACE INTO gcal_cache_events (calendar_id, event_id, start, end, all_day, data)
             VALUES (?, ?, ?, ?, ?, ?)`,
            // Timed events come with any offset ("…-04:00"); stored as UTC ISO so they
            // compare as strings.
            calendarId, e.id,
            e.allDay ? e.start : new Date(e.start).toISOString(),
            e.allDay ? e.end : new Date(e.end).toISOString(),
            e.allDay ? 1 : 0,
            JSON.stringify({
                summary: e.summary,
                htmlLink: e.htmlLink,
                location: e.location,
                description: e.description,
            }),
        );
    }
    for (let d = civilFromKey(first)!; civilKey(d) <= last; d = addDays(d, 1)) {
        sql.exec(
            "INSERT OR REPLACE INTO gcal_cache_days (calendar_id, day, synced_at) VALUES (?, ?, ?)",
            calendarId, civilKey(d), now,
        );
    }
}

/** Cached events for one calendar touching days first..last (instants fromISO..toISO). */
export function readDays(
    sql: SqlStorage,
    calendarId: string,
    first: string,
    last: string,
    fromISO: string,
    toISO: string,
): GoogleEvent[] {
    return sql
        .exec<{ event_id: string; start: string; end: string; all_day: number; data: string }>(
            `SELECT event_id, start, end, all_day, data FROM gcal_cache_events WHERE ${overlapSql} ORDER BY start`,
            calendarId, last, first, toISO, fromISO,
        )
        .toArray()
        .map((r) => ({ id: r.event_id, start: r.start, end: r.end, allDay: r.all_day === 1, ...JSON.parse(r.data) }));
}

/** Makes every cached day stale (a manual sync); events stay until refetched. */
export function forgetSync(sql: SqlStorage): void {
    sql.exec("DELETE FROM gcal_cache_days");
}

/** Everything, for a disconnect. */
export function clear(sql: SqlStorage): void {
    sql.exec("DELETE FROM gcal_cache_days");
    sql.exec("DELETE FROM gcal_cache_events");
}

/**
 * Drops days and events well in the past, so the cache doesn't grow forever. Never
 * anything from `keepFrom` on: the window being looked at stays, however old.
 */
export function prune(sql: SqlStorage, today: Civil, keepFrom: string): void {
    const monthAgo = civilKey(addDays(today, -KEEP_PAST_DAYS));
    const cutoff = keepFrom < monthAgo ? keepFrom : monthAgo;
    sql.exec("DELETE FROM gcal_cache_days WHERE day < ?", cutoff);
    sql.exec("DELETE FROM gcal_cache_events WHERE end < ?", cutoff);
}
