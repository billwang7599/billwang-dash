import {
    addDays,
    civilFromKey,
    civilKey,
    parseTimeToMinutes,
    zonedToUtcMs,
} from "../../shared/civil.ts";
import type { CalEvent, CalendarItem, EventInput } from "../../shared/types.ts";

/**
 * dash's own calendar events. Plain functions over the DO's SQL handle; UserDO
 * keeps the RPC methods, delegates here, and tells the Google push queue what changed.
 */

interface EventRow extends Record<string, SqlStorageValue> {
    id: string;
    title: string;
    description: string;
    start_date: string;
    start_time: string | null;
    end_date: string;
    end_time: string | null;
    created_at: string;
    updated_at: string;
}

const toCalEvent = (r: EventRow): CalEvent => ({
    id: r.id,
    title: r.title,
    description: r.description,
    startDate: r.start_date,
    startTime: r.start_time,
    endDate: r.end_date,
    endTime: r.end_time,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

export function getEvent(sql: SqlStorage, id: string): CalEvent | null {
    const [row] = sql.exec<EventRow>("SELECT * FROM events WHERE id = ?", id).toArray();
    return row ? toCalEvent(row) : null;
}

export function createEvent(sql: SqlStorage, input: EventInput): CalEvent {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sql.exec(
        `INSERT INTO events
           (id, title, description, start_date, start_time, end_date, end_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.title, input.description, input.startDate, input.startTime,
        input.endDate, input.endTime, now, now,
    );
    return getEvent(sql, id)!;
}

export function updateEvent(sql: SqlStorage, id: string, input: EventInput): CalEvent | null {
    sql.exec(
        `UPDATE events SET title = ?, description = ?, start_date = ?, start_time = ?,
                           end_date = ?, end_time = ?, updated_at = ?
         WHERE id = ?`,
        input.title, input.description, input.startDate, input.startTime,
        input.endDate, input.endTime, new Date().toISOString(), id,
    );
    return getEvent(sql, id);
}

/** Permanent. */
export function deleteEvent(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM events WHERE id = ?", id);
}

/** Events overlapping the window, placed on the timeline in the user's zone. */
export function eventCalendarItems(
    sql: SqlStorage,
    startISO: string,
    endISO: string,
    timeZone: string,
): CalendarItem[] {
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);
    // Dates are floating, so widen by a day each way, then filter on real instants.
    const from = civilFromKey(startISO.slice(0, 10));
    const to = civilFromKey(endISO.slice(0, 10));
    if (!from || !to) return [];

    const rows = sql
        .exec<EventRow>(
            "SELECT * FROM events WHERE start_date <= ? AND end_date >= ?",
            civilKey(addDays(to, 1)), civilKey(addDays(from, -1)),
        )
        .toArray();

    const items: CalendarItem[] = [];
    for (const row of rows) {
        const first = civilFromKey(row.start_date);
        const last = civilFromKey(row.end_date);
        if (!first || !last) continue;

        const allDay = row.start_time === null || row.end_time === null;
        const eventStart = zonedToUtcMs(first, allDay ? 0 : parseTimeToMinutes(row.start_time!), timeZone);
        const eventEnd = allDay
            ? zonedToUtcMs(addDays(last, 1), 0, timeZone)
            : zonedToUtcMs(last, parseTimeToMinutes(row.end_time!), timeZone);
        if (eventEnd <= startMs || eventStart >= endMs) continue;

        items.push({
            id: `event:${row.id}`,
            kind: "event",
            title: row.title,
            start: new Date(eventStart).toISOString(),
            end: new Date(eventEnd).toISOString(),
            allDay,
            event: toCalEvent(row),
        });
    }
    return items;
}
