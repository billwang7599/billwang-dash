import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, civilKey, zonedToUtcMs, type Civil } from "../shared/civil.ts";
import type { CalendarItem } from "../shared/types.ts";
import { api } from "./api.ts";
import { getCachedRange, rangeCacheKey, setCachedRange } from "./calendarCache.ts";

const bounds = (start: Civil, days: number, timeZone: string) => {
    const startISO = new Date(zonedToUtcMs(start, 0, timeZone)).toISOString();
    const endISO = new Date(zonedToUtcMs(addDays(start, days), 0, timeZone)).toISOString();
    return { startISO, endISO, key: rangeCacheKey(timeZone, startISO, endISO) };
};

/**
 * The calendar items for a range, painted from the in-memory cache when it has them and
 * revalidated behind it. `stamp` changes whenever the data may have (task edits, event
 * edits, Google sync): cached ranges from an older stamp are not trusted, but the items
 * already on screen stay up until the refetch lands.
 *
 * After a range loads, its neighbours are fetched too so paging to them is instant.
 */
export function useCalendarRange(rangeStart: Civil, dayCount: number, timeZone: string, stamp: string) {
    const rangeKey = `${civilKey(rangeStart)}:${dayCount}`;
    const cacheKey = useMemo(() => bounds(rangeStart, dayCount, timeZone).key, [rangeStart, dayCount, timeZone]);
    const cached = getCachedRange(cacheKey, stamp);

    // The last fetch to land, and the range it was for.
    const [data, setData] = useState<{ range: string | null; items: CalendarItem[] }>({ range: null, items: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const fetchRange = async (start: Civil) => {
            const { startISO, endISO, key } = bounds(start, dayCount, timeZone);
            const { items } = await api.calendar(startISO, endISO);
            setCachedRange(key, stamp, items);
            return items;
        };

        setLoading(true);
        fetchRange(rangeStart)
            .then((items) => {
                if (cancelled) return;
                // Same content as what is showing: keep the old array so nothing re-renders.
                setData((prev) =>
                    prev.range === rangeKey && JSON.stringify(prev.items) === JSON.stringify(items)
                        ? prev
                        : { range: rangeKey, items },
                );
                setError(null);
                for (const step of [-dayCount, dayCount]) {
                    const neighbour = addDays(rangeStart, step);
                    if (!getCachedRange(bounds(neighbour, dayCount, timeZone).key, stamp)) {
                        fetchRange(neighbour).catch(() => {}); // a warm-up; the real load reports errors
                    }
                }
            })
            .catch((err: Error) => !cancelled && setError(err.message))
            .finally(() => !cancelled && setLoading(false));

        return () => {
            cancelled = true;
        };
    }, [rangeStart, rangeKey, dayCount, timeZone, stamp]);

    /** Drop an item from what is showing, ahead of the server confirming the delete. */
    const removeItem = useCallback(
        (id: string) => setData((d) => ({ ...d, items: d.items.filter((i) => i.id !== id) })),
        [],
    );

    return {
        // Fetched data for this range is the freshest; the cache fills in before it lands.
        items: data.range === rangeKey ? data.items : (cached ?? data.items),
        /** Nothing to show for this range yet. */
        syncing: data.range !== rangeKey && !cached,
        /** A fetch is in flight, whether or not something is already showing. */
        loading,
        error,
        setError,
        removeItem,
    };
}
