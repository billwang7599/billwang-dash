import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eventProblem } from "../shared/events.ts";
import type { CalendarItem, EventInput } from "../shared/types.ts";
import { eventForCalEvent } from "../worker/google-sync.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

const timed = (over: Partial<EventInput> = {}): EventInput => ({
    title: "Standup",
    description: "",
    startDate: "2026-08-04",
    startTime: "10:00",
    endDate: "2026-08-04",
    endTime: "10:30",
    ...over,
});

const allDay = (over: Partial<EventInput> = {}): EventInput =>
    timed({ title: "Trip", startTime: null, endTime: null, ...over });

const WEEK_START = "2026-08-03T00:00:00.000Z";
const WEEK_END = "2026-08-10T00:00:00.000Z";

const eventsIn = async (name: string, from = WEEK_START, to = WEEK_END) =>
    (await stub(name).getCalendarItems(from, to)).filter((i) => i.kind === "event");

describe("eventProblem", () => {
    it("accepts timed and all-day events, including overnight and multi-day", () => {
        expect(eventProblem(timed())).toBeNull();
        expect(eventProblem(allDay())).toBeNull();
        expect(eventProblem(timed({ startTime: "22:00", endDate: "2026-08-05", endTime: "02:00" }))).toBeNull();
        expect(eventProblem(allDay({ endDate: "2026-08-07" }))).toBeNull();
    });

    it("refuses what cannot be saved", () => {
        expect(eventProblem(timed({ title: "   " }))).toMatch(/title/i);
        expect(eventProblem(timed({ startDate: "2026-02-31" }))).toMatch(/dates/i);
        expect(eventProblem(timed({ endDate: "2026-08-03" }))).toMatch(/before it starts/i);
        expect(eventProblem(timed({ endTime: null }))).toMatch(/both times/i);
        expect(eventProblem(timed({ startTime: "25:00" }))).toMatch(/times/i);
        expect(eventProblem(timed({ endTime: "10:00" }))).toMatch(/after the start/i);
        expect(eventProblem(timed({ endTime: "09:00" }))).toMatch(/after the start/i);
    });
});

describe("dash events on the calendar", () => {
    it("pins a timed event to its moment, so a zone change moves its clock time", async () => {
        const s = stub("ev-zone");
        await s.createEvent(timed());
        let [item] = await eventsIn("ev-zone");
        expect(item).toMatchObject({ kind: "event", title: "Standup", allDay: false, start: "2026-08-04T10:00:00.000Z" });

        await s.setPreferences({ timeZone: "America/Chicago" });
        [item] = await eventsIn("ev-zone");
        expect(item.start).toBe("2026-08-04T10:00:00.000Z"); // the same moment...
        expect(item.end).toBe("2026-08-04T10:30:00.000Z");
        expect(item.event).toMatchObject({ startDate: "2026-08-04", startTime: "05:00" }); // ...5am in Chicago
    });

    it("carries the editable wall-clock fields", async () => {
        const created = await stub("ev-fields").createEvent(timed({ description: "Bring notes" }));
        const [item] = await eventsIn("ev-fields");
        expect(item.id).toBe(`event:${created.id}`);
        expect(item.event).toMatchObject({ id: created.id, startTime: "10:00", description: "Bring notes" });
    });

    it("spans an all-day event over its inclusive end date", async () => {
        await stub("ev-allday").createEvent(allDay({ startDate: "2026-08-04", endDate: "2026-08-06" }));
        const [item] = await eventsIn("ev-allday");
        expect(item).toMatchObject({ allDay: true, start: "2026-08-04T00:00:00.000Z", end: "2026-08-07T00:00:00.000Z" });
    });

    it("includes an overnight event in the window it runs into, and leaves out ones outside", async () => {
        const s = stub("ev-window");
        await s.createEvent(timed({ title: "Late", startTime: "22:00", endDate: "2026-08-10", endTime: "02:00", startDate: "2026-08-09" }));
        await s.createEvent(timed({ title: "Before", startDate: "2026-07-28", endDate: "2026-07-28" }));
        await s.createEvent(timed({ title: "After", startDate: "2026-08-20", endDate: "2026-08-20" }));

        expect((await eventsIn("ev-window")).map((i) => i.title)).toEqual(["Late"]);
        // The next week still sees the part that runs past midnight.
        expect((await eventsIn("ev-window", "2026-08-10T00:00:00.000Z", "2026-08-17T00:00:00.000Z")).map((i) => i.title)).toEqual(["Late"]);
    });

    it("sorts events among tasks by start", async () => {
        const s = stub("ev-sort");
        await s.createEvent(timed({ title: "Late event", startTime: "15:00", endTime: "16:00" }));
        await s.createTask({ content: "Early task", due: { date: "2026-08-04", time: "09:00", recurrence: null } });
        const items: CalendarItem[] = await s.getCalendarItems(WEEK_START, WEEK_END);
        expect(items.map((i) => i.title)).toEqual(["Early task", "Late event"]);
    });

    it("updates and deletes", async () => {
        const s = stub("ev-edit");
        const e = await s.createEvent(timed());
        const updated = await s.updateEvent(e.id, timed({ title: "Retro", startTime: "11:00", endTime: "12:00" }));
        expect(updated).toMatchObject({ title: "Retro", startTime: "11:00" });
        expect((await eventsIn("ev-edit"))[0].start).toBe("2026-08-04T11:00:00.000Z");

        await s.deleteEvent(e.id);
        expect(await eventsIn("ev-edit")).toEqual([]);
        expect(await s.updateEvent("nope", timed())).toBeNull();
    });
});

describe("dash events over HTTP", () => {
    const call = (method: string, path: string, body?: unknown) =>
        SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it("creates, edits, lists on the calendar, and deletes", async () => {
        const created = await call("POST", "/api/events", timed({ title: "  Design review  " }));
        expect(created.status).toBe(201);
        const { event } = await created.json<{ event: { id: string; title: string } }>();
        expect(event.title).toBe("Design review");

        const patched = await call("PATCH", `/api/events/${event.id}`, timed({ title: "Design critique", description: "Room 4" }));
        expect(patched.status).toBe(200);

        const cal = await (await call("GET", `/api/calendar?start=${WEEK_START}&end=${WEEK_END}`)).json<{ items: CalendarItem[] }>();
        expect(cal.items.find((i) => i.id === `event:${event.id}`)).toMatchObject({ title: "Design critique" });

        expect((await call("DELETE", `/api/events/${event.id}`)).status).toBe(204);
        const after = await (await call("GET", `/api/calendar?start=${WEEK_START}&end=${WEEK_END}`)).json<{ items: CalendarItem[] }>();
        expect(after.items.some((i) => i.id === `event:${event.id}`)).toBe(false);
    });

    it("rejects an event the editor would not have saved", async () => {
        for (const bad of [
            timed({ title: "" }),
            timed({ endTime: null }),
            timed({ endDate: "2026-08-03" }),
            timed({ endTime: "10:00" }),
            timed({ startDate: "not-a-date" }),
        ]) {
            expect((await call("POST", "/api/events", bad)).status).toBe(400);
        }
    });

    it("404 when editing an event that does not exist", async () => {
        expect((await call("PATCH", "/api/events/nope", timed())).status).toBe(404);
    });
});

describe("eventForCalEvent", () => {
    const base = { id: "e1", description: "", createdAt: "", updatedAt: "" };

    it("writes a timed event in the profile zone, ending on its own end date", () => {
        const g = eventForCalEvent(
            { ...base, title: "Party", startDate: "2026-08-04", startTime: "22:00", endDate: "2026-08-05", endTime: "02:00" },
            "Asia/Tokyo",
            "https://dash.example/",
        );
        expect(g.start).toEqual({ dateTime: "2026-08-04T22:00:00", timeZone: "Asia/Tokyo" });
        expect(g.end).toEqual({ dateTime: "2026-08-05T02:00:00", timeZone: "Asia/Tokyo" });
        expect(g.extendedProperties.private.dashTaskId).toBe("e1");
        expect(g.description).toBe("Open in dash: https://dash.example/app/calendar");
    });

    it("turns the inclusive all-day end date into Google's exclusive one", () => {
        const g = eventForCalEvent(
            { ...base, title: "Trip", description: "Pack", startDate: "2026-12-30", startTime: null, endDate: "2026-12-31", endTime: null },
            "UTC",
            "https://dash.example",
        );
        expect(g.start).toEqual({ date: "2026-12-30" });
        expect(g.end).toEqual({ date: "2027-01-01" });
        expect(g.description).toContain("Pack");
    });
});
