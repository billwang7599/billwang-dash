import type { CalendarItem } from "../shared/types.ts";

/**
 * In-memory copy of the calendar ranges already fetched, so paging back to a week
 * (or reopening the view) paints at once and revalidates behind it.
 *
 * Every entry is stamped with the data version it was fetched under. When the version
 * moves on (a task or event changed, Google was synced) the old entries are wrong, so
 * `get` ignores them and `set` evicts them. Nothing here outlives the page.
 */
const MAX_ENTRIES = 24;

const entries = new Map<string, { stamp: string; items: CalendarItem[] }>();

export const rangeCacheKey = (timeZone: string, startISO: string, endISO: string) =>
    `${timeZone}|${startISO}|${endISO}`;

export function getCachedRange(key: string, stamp: string): CalendarItem[] | undefined {
    const hit = entries.get(key);
    return hit?.stamp === stamp ? hit.items : undefined;
}

export function setCachedRange(key: string, stamp: string, items: CalendarItem[]) {
    for (const [k, v] of entries) if (v.stamp !== stamp) entries.delete(k);
    entries.delete(key); // re-insert so the oldest entry is always first
    entries.set(key, { stamp, items });
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

export function clearCalendarCache() {
    entries.clear();
}
