import type { CalendarItem } from "../shared/types.ts";

export interface PlacedEvent {
    item: CalendarItem;
    /** Zero-based lane within its cluster of overlapping events. */
    column: number;
    /** Lanes in that cluster; events elsewhere in the day don't count. */
    columns: number;
    /** Lanes this event covers: it stretches right across lanes nobody else uses. */
    span: number;
}

interface Slot {
    item: CalendarItem;
    start: number;
    end: number;
    column: number;
}

/**
 * Side-by-side placement for overlapping events.
 *
 * Events are grouped into clusters that overlap, directly or through a chain.
 * Each cluster is laid out on its own, so a lone event keeps the full width of
 * the day even when another part of the day is crowded. Inside a cluster, an
 * event takes the first free lane, then stretches across any lanes to its right
 * that are free for its whole duration.
 */
export function layoutEvents(items: CalendarItem[]): PlacedEvent[] {
    const sorted = items
        .map((item) => ({ item, start: Date.parse(item.start), end: Date.parse(item.end) }))
        .sort((a, b) => a.start - b.start || b.end - a.end);

    const out: PlacedEvent[] = [];
    let cluster: Slot[] = [];
    let clusterEnd = -Infinity;

    const flush = () => {
        const columns = cluster.reduce((max, s) => Math.max(max, s.column + 1), 1);
        for (const slot of cluster) {
            let span = 1;
            while (
                slot.column + span < columns &&
                !cluster.some(
                    (other) =>
                        other.column === slot.column + span &&
                        other.start < slot.end &&
                        other.end > slot.start,
                )
            ) {
                span++;
            }
            out.push({ item: slot.item, column: slot.column, columns, span });
        }
        cluster = [];
    };

    for (const event of sorted) {
        if (cluster.length > 0 && event.start >= clusterEnd) flush();

        // First lane whose events have all finished by the time this one starts.
        let column = 0;
        while (cluster.some((s) => s.column === column && s.end > event.start)) column++;

        cluster.push({ ...event, column });
        clusterEnd = Math.max(clusterEnd, event.end);
    }
    flush();

    return out;
}
