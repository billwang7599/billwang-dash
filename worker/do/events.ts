import {
    addDays,
    civilFromDate,
    civilFromKey,
    civilKey,
    minutesOfDay,
    minutesToTime,
    zonedToUtcMs,
} from "../../shared/civil.ts";
import type { CalEvent, CalendarItem, EventInput } from "../../shared/types.ts";
import { profileTimeZone } from "./common.ts";
import { instantOf, toIso } from "./time.ts";

/**
 * dash's own calendar events. Plain functions over the DO's SQL handle; UserDO
 * keeps the RPC methods, delegates here, and tells the Google push queue what changed.
 */

interface EventRow extends Record<string, SqlStorageValue> {
    id: string;
    title: string;
    description: string;
    /** All-day events are plain dates (end_date is the last day, inclusive)... */
    all_day: number;
    start_date: string | null;
    end_date: string | null;
    /** ...timed ones are instants, set in tz. */
    start_at: number | null;
    end_at: number | null;
    tz: string | null;
    created_at: number;
    updated_at: number;
}

/** The event as the client sees it: a timed event's dates and times are read in `zone`. */
const toCalEvent = (r: EventRow, zone: string): CalEvent => {
    const base = {
        id: r.id,
        title: r.title,
        description: r.description,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
    if (r.all_day === 1) {
        return { ...base, startDate: r.start_date!, startTime: null, endDate: r.end_date!, endTime: null };
    }
    const start = new Date(r.start_at!);
    const end = new Date(r.end_at!);
    return {
        ...base,
        startDate: civilKey(civilFromDate(start, zone)),
        startTime: minutesToTime(minutesOfDay(start, zone)),
        endDate: civilKey(civilFromDate(end, zone)),
        endTime: minutesToTime(minutesOfDay(end, zone)),
    };
};

export function getEvent(sql: SqlStorage, id: string): CalEvent | null {
    const [row] = sql.exec<EventRow>("SELECT * FROM events WHERE id = ?", id).toArray();
    return row ? toCalEvent(row, profileTimeZone(sql)) : null;
}

/** The columns an input becomes, its times read in `zone`. */
function columns(input: EventInput, zone: string) {
    const allDay = input.startTime === null || input.endTime === null;
    return allDay
        ? { allDay, startDate: input.startDate, endDate: input.endDate, startAt: null, endAt: null }
        : {
              allDay,
              startDate: null,
              endDate: null,
              startAt: instantOf(input.startDate, input.startTime, zone),
              endAt: instantOf(input.endDate, input.endTime, zone),
          };
}

export function createEvent(sql: SqlStorage, input: EventInput): CalEvent {
    const id = crypto.randomUUID();
    const now = Date.now();
    const zone = profileTimeZone(sql);
    const c = columns(input, zone);
    sql.exec(
        `INSERT INTO events
           (id, title, description, all_day, start_date, end_date, start_at, end_at, tz, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.title, input.description, c.allDay ? 1 : 0, c.startDate, c.endDate, c.startAt, c.endAt,
        c.allDay ? null : zone, now, now,
    );
    return getEvent(sql, id)!;
}

export function updateEvent(sql: SqlStorage, id: string, input: EventInput): CalEvent | null {
    const [was] = sql.exec<EventRow>("SELECT * FROM events WHERE id = ?", id).toArray();
    if (!was) return null;
    const zone = profileTimeZone(sql);
    const c = columns(input, zone);
    // Saving without touching the times must not re-pin the event to wherever you are now.
    const unchanged = !c.allDay && was.all_day === 0 && c.startAt === was.start_at && c.endAt === was.end_at;
    sql.exec(
        `UPDATE events SET title = ?, description = ?, all_day = ?, start_date = ?, end_date = ?,
                           start_at = ?, end_at = ?, tz = ?, updated_at = ?
         WHERE id = ?`,
        input.title, input.description, c.allDay ? 1 : 0, c.startDate, c.endDate, c.startAt, c.endAt,
        c.allDay ? null : unchanged ? (was.tz ?? zone) : zone, Date.now(), id,
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
    // All-day dates are floating, so widen by a day each way, then filter on real instants.
    const from = civilFromKey(startISO.slice(0, 10));
    const to = civilFromKey(endISO.slice(0, 10));
    if (!from || !to) return [];

    const rows = sql
        .exec<EventRow>(
            `SELECT * FROM events
             WHERE (all_day = 0 AND start_at < ? AND end_at > ?)
                OR (all_day = 1 AND start_date <= ? AND end_date >= ?)`,
            endMs, startMs, civilKey(addDays(to, 1)), civilKey(addDays(from, -1)),
        )
        .toArray();

    const items: CalendarItem[] = [];
    for (const row of rows) {
        let eventStart: number;
        let eventEnd: number;
        if (row.all_day === 1) {
            const first = civilFromKey(row.start_date!);
            const last = civilFromKey(row.end_date!);
            if (!first || !last) continue;
            eventStart = zonedToUtcMs(first, 0, timeZone);
            eventEnd = zonedToUtcMs(addDays(last, 1), 0, timeZone);
        } else {
            eventStart = row.start_at!;
            eventEnd = row.end_at!;
        }
        if (eventEnd <= startMs || eventStart >= endMs) continue;

        items.push({
            id: `event:${row.id}`,
            kind: "event",
            title: row.title,
            start: new Date(eventStart).toISOString(),
            end: new Date(eventEnd).toISOString(),
            allDay: row.all_day === 1,
            event: toCalEvent(row, timeZone),
        });
    }
    return items;
}
