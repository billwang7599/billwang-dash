import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WRITE_SCOPE } from "../worker/google.ts";
import * as service from "../worker/service.ts";
import { eventIdForTask } from "../worker/google-sync.ts";

type Call = { method: string; path: string; body?: any };
type Failure = { status: number; body?: unknown };

/**
 * An in-memory Google Calendar. It keeps Google's real behaviours that the sync
 * leans on: an event id can't be reused (409) even after deletion, a deleted
 * event is "cancelled", and updating one revives it.
 */
function fakeGoogle(opts: { eventsList?: unknown[]; calendarList?: unknown[] } = {}) {
    const events = new Map<string, { status: "confirmed" | "cancelled"; body: any }>();
    const calls: Call[] = [];
    const deletedCalendars: string[] = [];
    let createdCalendars = 0;
    let fail: ((call: Call) => Failure | undefined) | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const path = decodeURIComponent(url.pathname.replace("/calendar/v3", ""));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const call = { method, path, body };
        calls.push(call);

        // Responses are built here, per call, so they belong to the caller's Durable Object.
        const reply = (status: number, json: unknown = {}) =>
            new Response(status === 204 ? null : JSON.stringify(json), { status });

        const failure = fail?.(call);
        if (failure) return reply(failure.status, failure.body);

        if (method === "GET" && path === "/users/me/calendarList") {
            return reply(200, {
                items: opts.calendarList ?? [{ id: "me@example.com", summary: "Me", primary: true }],
            });
        }
        if (method === "POST" && path === "/calendars") {
            createdCalendars++;
            return reply(200, { id: `dashcal${createdCalendars}` });
        }
        const calDelete = method === "DELETE" && path.match(/^\/calendars\/([^/]+)$/);
        if (calDelete) {
            deletedCalendars.push(calDelete[1]);
            return reply(204);
        }
        const list = method === "GET" && path.match(/^\/calendars\/[^/]+\/events$/);
        if (list) return reply(200, { items: opts.eventsList ?? [] });

        if (method === "POST" && /^\/calendars\/[^/]+\/events$/.test(path)) {
            if (events.has(body.id)) return reply(409, { error: { errors: [{ reason: "duplicate" }] } });
            events.set(body.id, { status: "confirmed", body });
            return reply(200, body);
        }
        const one = path.match(/^\/calendars\/[^/]+\/events\/([^/]+)$/);
        if (one && method === "PUT") {
            if (!events.has(one[1])) return reply(404);
            events.set(one[1], { status: "confirmed", body });
            return reply(200, body);
        }
        if (one && method === "DELETE") {
            const e = events.get(one[1]);
            if (!e) return reply(404);
            if (e.status === "cancelled") return reply(410);
            e.status = "cancelled";
            return reply(204);
        }
        return reply(404);
    });

    return {
        calls,
        deletedCalendars,
        live: () => [...events].filter(([, e]) => e.status === "confirmed"),
        event: (taskId: string) => events.get(eventIdForTask(taskId)),
        failWith: (f: ((call: Call) => Failure | undefined) | null) => (fail = f),
        writes: () => calls.filter((c) => c.method !== "GET").length,
    };
}

const WRITE = `https://www.googleapis.com/auth/calendar.readonly ${WRITE_SCOPE} openid email`;
const READ_ONLY = "https://www.googleapis.com/auth/calendar.readonly openid email";

/** DOs touched by a test; their alarms are cleared afterwards or isolated storage fails. */
const used = new Set<string>();

async function connected(name: string, scope = WRITE, email = "me@example.com") {
    used.add(name);
    const stub = env.USER_DO.getByName(name);
    await stub.connectGoogle({
        accessToken: "tok",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        email,
        scope,
    });
    return stub;
}

const timed = (content: string, date = "2026-08-04", time = "17:00") => ({
    content,
    due: { date, time, recurrence: null },
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of used) {
        await runInDurableObject(env.USER_DO.getByName(name), (_i, state) => state.storage.deleteAlarm());
    }
    used.clear();
});

describe("google push: setup", () => {
    it("needs the write scope before syncing can be turned on", async () => {
        fakeGoogle();
        const stub = await connected("gp-scope", READ_ONLY);
        expect(await stub.getGoogleStatus()).toMatchObject({ canWrite: false, push: { enabled: false } });
        // Through the service, which checks first: an error thrown across the DO RPC boundary
        // breaks vitest's isolated storage, and users should get a 400 rather than a 500 anyway.
        const configured = { ...env, GOOGLE_CLIENT_ID: "client" };
        await expect(service.setGooglePush(stub, configured, true)).rejects.toMatchObject({ status: 400 });
        expect((await stub.getGoogleStatus()).push.enabled).toBe(false);
    });

    it("creates the dash calendar and backfills only tasks that can have an event", async () => {
        const g = fakeGoogle();
        const stub = await connected("gp-enable");
        const a = await stub.createTask(timed("Timed"));
        const b = await stub.createTask({ content: "All day", due: { date: "2026-08-05", time: null, recurrence: null } });
        await stub.createTask({ content: "Undated" });
        const done = await stub.createTask(timed("Done"));
        await stub.completeTask(done.id, "2026-08-04");

        const status = await stub.setGooglePush(true);
        expect(status).toMatchObject({ canWrite: true, push: { enabled: true, error: null } });
        expect(g.calls.find((c) => c.path === "/calendars")?.body).toMatchObject({ summary: "dash" });

        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(g.live().map(([id]) => id).sort()).toEqual([eventIdForTask(a.id), eventIdForTask(b.id)].sort());
        expect(g.event(a.id)!.body.start).toMatchObject({ dateTime: "2026-08-04T17:00:00" });
        expect(g.event(b.id)!.body).toMatchObject({ start: { date: "2026-08-05" }, transparency: "transparent" });
        expect((await stub.getGoogleStatus()).push.pending).toBe(0);
    });

    it("does nothing while syncing is off", async () => {
        const g = fakeGoogle();
        const stub = await connected("gp-off");
        await stub.createTask(timed("Quiet"));
        expect(await runDurableObjectAlarm(stub)).toBe(false);
        expect(g.writes()).toBe(0);
    });
});

describe("google push: following task changes", () => {
    async function enabled(name: string) {
        const g = fakeGoogle();
        const stub = await connected(name);
        await stub.setGooglePush(true);
        await runDurableObjectAlarm(stub);
        return { g, stub };
    }

    it("creates, updates, and skips a no-op edit", async () => {
        const { g, stub } = await enabled("gp-edit");
        const t = await stub.createTask(timed("First"));
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.body.summary).toBe("First");

        await stub.updateTask(t.id, { content: "Renamed" });
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.body.summary).toBe("Renamed");

        const before = g.writes();
        await stub.updateTask(t.id, { content: "Renamed" }); // same payload
        await runDurableObjectAlarm(stub);
        expect(g.writes()).toBe(before);
    });

    it("removes the event on completion and brings it back on un-complete", async () => {
        const { g, stub } = await enabled("gp-done");
        const t = await stub.createTask(timed("Finish me"));
        await runDurableObjectAlarm(stub);

        await stub.completeTask(t.id, "2026-08-04");
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(0);
        expect(g.event(t.id)!.status).toBe("cancelled");

        // The id still exists in Google, so the insert 409s and falls back to a revive.
        await stub.uncompleteTask(t.id);
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.status).toBe("confirmed");
        expect(g.calls.some((c) => c.method === "POST" && c.body?.id === eventIdForTask(t.id) && c.path.endsWith("/events"))).toBe(true);
    });

    it("follows the trash both ways, for tasks and for whole projects", async () => {
        const { g, stub } = await enabled("gp-trash");
        const solo = await stub.createTask(timed("Solo"));
        const inProject = await stub.createTask({ ...timed("In project"), projectName: "Gone" });
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(2);

        await stub.deleteTask(solo.id);
        await stub.deleteProject(inProject.projectId);
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(0);

        await stub.restoreTask(solo.id);
        await stub.restoreProject(inProject.projectId);
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(2);
    });

    it("moves a recurring task's single event forward when it is completed", async () => {
        const { g, stub } = await enabled("gp-recur");
        const recurrence = { freq: "daily" as const, interval: 1, weekdays: [], month: null, monthDay: null, fromCompletion: false };
        const t = await stub.createTask({ content: "Daily", due: { date: "2026-08-04", time: null, recurrence } });
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.body.start).toEqual({ date: "2026-08-04" });

        await stub.completeTask(t.id, "2026-08-04");
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.body.start).toEqual({ date: "2026-08-05" });
        expect(g.live()).toHaveLength(1);
    });

    it("rewrites every event when the time zone changes", async () => {
        const { g, stub } = await enabled("gp-zone");
        const t = await stub.createTask(timed("Floats"));
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.body.start.timeZone).toBe("UTC");

        await stub.setPreferences({ timeZone: "Asia/Tokyo" });
        await runDurableObjectAlarm(stub);
        expect(g.event(t.id)!.body.start).toEqual({ dateTime: "2026-08-04T17:00:00", timeZone: "Asia/Tokyo" });
    });

    it("drops the event when a task loses its due date", async () => {
        const { g, stub } = await enabled("gp-undate");
        const t = await stub.createTask(timed("Unscheduled soon"));
        await runDurableObjectAlarm(stub);
        await stub.updateTask(t.id, { due: null });
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(0);
    });
});

describe("google push: failures", () => {
    async function enabled(name: string) {
        const g = fakeGoogle();
        const stub = await connected(name);
        await stub.setGooglePush(true);
        await runDurableObjectAlarm(stub);
        return { g, stub };
    }

    it("stops and says why when Google denies access", async () => {
        const { g, stub } = await enabled("gp-denied");
        g.failWith((c) => (c.method === "POST" ? { status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }] } } } : undefined));
        await stub.createTask(timed("Blocked"));
        await runDurableObjectAlarm(stub);

        const { push } = await stub.getGoogleStatus();
        expect(push.enabled).toBe(false);
        expect(push.error).toMatch(/denied access/i);
        expect(push.pending).toBe(0);
    });

    it("keeps trying, with backoff, through a rate limit", async () => {
        const { g, stub } = await enabled("gp-rate");
        g.failWith((c) => (c.method === "POST" ? { status: 429 } : undefined));
        await stub.createTask(timed("Later"));
        await runDurableObjectAlarm(stub);

        const { push } = await stub.getGoogleStatus();
        expect(push).toMatchObject({ enabled: true, error: null, pending: 1 });
        expect(g.live()).toHaveLength(0);

        // Once Google recovers the queued task is pushed.
        g.failWith(null);
        await runDurableObjectAlarm(stub); // not due yet (backoff), so nothing happens
        expect((await stub.getGoogleStatus()).push.pending).toBe(1);
    });

    it("notices when the dash calendar was deleted in Google, and can recreate it", async () => {
        const { g, stub } = await enabled("gp-gone");
        g.failWith((c) => (c.method === "POST" && c.path.endsWith("/events") ? { status: 404 } : undefined));
        await stub.createTask(timed("Orphaned"));
        await runDurableObjectAlarm(stub);
        expect((await stub.getGoogleStatus()).push).toMatchObject({ enabled: false, error: expect.stringMatching(/deleted in Google/) });

        g.failWith(null);
        await stub.setGooglePush(true);
        expect(g.calls.filter((c) => c.method === "POST" && c.path === "/calendars")).toHaveLength(2);
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(1);
    });

    it("does not let one task Google rejects stall the others", async () => {
        const { g, stub } = await enabled("gp-fatal");
        g.failWith((c) => (c.method === "POST" && c.body?.summary === "Bad" ? { status: 400, body: { error: { errors: [{ reason: "invalid" }] } } } : undefined));
        await stub.createTask(timed("Bad"));
        const good = await stub.createTask(timed("Good"));
        await runDurableObjectAlarm(stub);
        expect(g.event(good.id)).toBeDefined();
        expect((await stub.getGoogleStatus()).push).toMatchObject({ enabled: true, pending: 0 });
    });
});

describe("google push: lifecycle", () => {
    it("turning it off deletes the dash calendar and stops pushing", async () => {
        const g = fakeGoogle();
        const stub = await connected("gp-turnoff");
        await stub.setGooglePush(true);
        await stub.createTask(timed("One"));
        await runDurableObjectAlarm(stub);

        const status = await stub.setGooglePush(false);
        expect(g.deletedCalendars).toEqual(["dashcal1"]);
        expect(status.push).toMatchObject({ enabled: false, pending: 0 });

        const before = g.writes();
        await stub.createTask(timed("Two"));
        expect(await runDurableObjectAlarm(stub)).toBe(false);
        expect(g.writes()).toBe(before);
    });

    it("disconnecting also removes the dash calendar", async () => {
        const g = fakeGoogle();
        const stub = await connected("gp-disconnect");
        await stub.setGooglePush(true);
        await stub.disconnectGoogle();
        expect(g.deletedCalendars).toEqual(["dashcal1"]);
        expect((await stub.getGoogleStatus()).connected).toBe(false);
    });

    it("reconnecting the same account keeps syncing on; a different account starts clean", async () => {
        fakeGoogle();
        const stub = await connected("gp-reconnect");
        await stub.setGooglePush(true);

        await connected("gp-reconnect"); // same email, same stub
        expect((await stub.getGoogleStatus()).push.enabled).toBe(true);

        await connected("gp-reconnect", WRITE, "someone-else@example.com");
        expect((await stub.getGoogleStatus()).push.enabled).toBe(false);
    });

    it("turns syncing off if a reconnect no longer grants write access", async () => {
        fakeGoogle();
        const stub = await connected("gp-downgrade");
        await stub.setGooglePush(true);
        await connected("gp-downgrade", READ_ONLY);
        expect(await stub.getGoogleStatus()).toMatchObject({ canWrite: false, push: { enabled: false } });
    });
});

describe("google push: no double display", () => {
    it("hides the dash calendar and any event dash wrote from the in-app calendar", async () => {
        const g = fakeGoogle({
            calendarList: [
                { id: "me@example.com", summary: "Me", primary: true },
                { id: "dashcal1", summary: "dash" },
            ],
            eventsList: [
                { id: "e1", summary: "Dentist", start: { dateTime: "2026-08-04T15:00:00Z" }, end: { dateTime: "2026-08-04T16:00:00Z" } },
                {
                    id: "e2",
                    summary: "Mirrored task",
                    start: { dateTime: "2026-08-04T17:00:00Z" },
                    end: { dateTime: "2026-08-04T17:30:00Z" },
                    extendedProperties: { private: { dashTaskId: "t1" } },
                },
            ],
        });
        const stub = await connected("gp-display");
        await stub.setGooglePush(true); // dash calendar id becomes "dashcal1"
        await connected("gp-display"); // reconnect re-lists calendars, now including it

        const status = await stub.getGoogleStatus();
        expect(status.calendars.map((c) => c.id)).toEqual(["me@example.com"]);

        const items = await stub.getCalendarItems("2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z");
        expect(items.filter((i) => i.kind === "gcal").map((i) => i.title)).toEqual(["Dentist"]);
        expect(g.calls.length).toBeGreaterThan(0);
    });
});

describe("google push: dash events", () => {
    const meeting = (title = "Standup") => ({
        title,
        description: "",
        startDate: "2026-08-04",
        startTime: "10:00",
        endDate: "2026-08-04",
        endTime: "10:30",
    });

    async function enabled(name: string) {
        const g = fakeGoogle();
        const stub = await connected(name);
        await stub.setGooglePush(true);
        await runDurableObjectAlarm(stub);
        return { g, stub };
    }

    it("pushes an event, follows edits, and removes it when deleted", async () => {
        const { g, stub } = await enabled("gpe-flow");
        const e = await stub.createEvent(meeting());
        await runDurableObjectAlarm(stub);
        expect(g.event(e.id)!.body).toMatchObject({
            summary: "Standup",
            start: { dateTime: "2026-08-04T10:00:00", timeZone: "UTC" },
            extendedProperties: { private: { dashTaskId: e.id } },
        });

        await stub.updateEvent(e.id, { ...meeting("Retro"), startTime: "11:00", endTime: "12:00" });
        await runDurableObjectAlarm(stub);
        expect(g.event(e.id)!.body).toMatchObject({ summary: "Retro", start: { dateTime: "2026-08-04T11:00:00" } });

        await stub.deleteEvent(e.id);
        await runDurableObjectAlarm(stub);
        expect(g.live()).toHaveLength(0);
        expect(g.event(e.id)!.status).toBe("cancelled");
    });

    it("sends an all-day event with Google's exclusive end date", async () => {
        const { g, stub } = await enabled("gpe-allday");
        const e = await stub.createEvent({ ...meeting("Trip"), startTime: null, endTime: null, endDate: "2026-08-06" });
        await runDurableObjectAlarm(stub);
        expect(g.event(e.id)!.body).toMatchObject({ start: { date: "2026-08-04" }, end: { date: "2026-08-07" } });
    });

    it("backfills events that already existed when syncing was turned on", async () => {
        const g = fakeGoogle();
        const stub = await connected("gpe-backfill");
        const e = await stub.createEvent(meeting());
        const t = await stub.createTask({ content: "A task", due: { date: "2026-08-05", time: null, recurrence: null } });

        await stub.setGooglePush(true);
        await runDurableObjectAlarm(stub);
        expect(g.live().map(([id]) => id).sort()).toEqual([eventIdForTask(e.id), eventIdForTask(t.id)].sort());
    });

    it("moves events when the time zone changes", async () => {
        const { g, stub } = await enabled("gpe-zone");
        const e = await stub.createEvent(meeting());
        await runDurableObjectAlarm(stub);
        await stub.setPreferences({ timeZone: "Asia/Tokyo" });
        await runDurableObjectAlarm(stub);
        expect(g.event(e.id)!.body.start).toEqual({ dateTime: "2026-08-04T10:00:00", timeZone: "Asia/Tokyo" });
    });

    it("never shows the pushed event twice in the in-app calendar", async () => {
        fakeGoogle({
            eventsList: [
                {
                    id: "mirror",
                    summary: "Mirrored",
                    start: { dateTime: "2026-08-04T10:00:00Z" },
                    end: { dateTime: "2026-08-04T10:30:00Z" },
                    extendedProperties: { private: { dashTaskId: "any-dash-id" } },
                },
            ],
        });
        const stub = await connected("gpe-nodup");
        await stub.createEvent(meeting());
        const items = await stub.getCalendarItems("2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z");
        expect(items.map((i) => i.kind)).toEqual(["event"]);
    });
});
