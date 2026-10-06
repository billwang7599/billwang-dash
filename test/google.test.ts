import { afterEach, describe, expect, it, vi } from "vitest";
import {
    GoogleApiError,
    WRITE_SCOPE,
    buildAuthUrl,
    createCalendar,
    deleteCalendar,
    deleteEvent,
    exchangeCode,
    insertEvent,
    listEvents,
    updateEvent,
    type GoogleEventPayload,
} from "../worker/google.ts";

const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    APP_ORIGIN: "https://dash.example",
} as unknown as Env;

const payload: GoogleEventPayload = {
    summary: "Review specs",
    start: { dateTime: "2026-08-04T17:00:00", timeZone: "America/Chicago" },
    end: { dateTime: "2026-08-04T17:30:00", timeZone: "America/Chicago" },
    extendedProperties: { private: { dashTaskId: "t1" } },
};

/** Responses are built per call: one made outside a Durable Object can't be read inside one. */
function mockFetch(status: number, body: unknown = {}) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(status === 204 ? null : JSON.stringify(body), { status }),
    );
}

const lastCall = (spy: ReturnType<typeof mockFetch>) => {
    const [url, init] = spy.mock.calls.at(-1)!;
    return {
        url: String(url),
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
};

afterEach(() => vi.restoreAllMocks());

describe("google scopes", () => {
    it("asks for the app-created write scope alongside read-only", () => {
        const scope = new URL(buildAuthUrl(env, "s")).searchParams.get("scope")!;
        expect(scope).toContain("calendar.readonly");
        expect(scope).toContain(WRITE_SCOPE);
    });

    it("records which scopes Google actually granted", async () => {
        mockFetch(200, { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "x y" });
        expect((await exchangeCode(env, "code")).scope).toBe("x y");
    });
});

describe("google writes", () => {
    it("creates a calendar and returns its id", async () => {
        const spy = mockFetch(200, { id: "cal123" });
        expect(await createCalendar("tok", "dash", "America/Chicago")).toBe("cal123");
        expect(lastCall(spy)).toMatchObject({
            url: "https://www.googleapis.com/calendar/v3/calendars",
            method: "POST",
            body: { summary: "dash", timeZone: "America/Chicago" },
        });
        expect(lastCall(spy).headers.authorization).toBe("Bearer tok");
    });

    it("inserts an event under a caller-chosen id", async () => {
        const spy = mockFetch(200);
        await insertEvent("tok", "cal@group", "dashabc", payload);
        expect(lastCall(spy)).toMatchObject({
            url: "https://www.googleapis.com/calendar/v3/calendars/cal%40group/events",
            method: "POST",
            body: { id: "dashabc", summary: "Review specs" },
        });
    });

    it("updates with PUT and revives a deleted event", async () => {
        const spy = mockFetch(200);
        await updateEvent("tok", "cal", "dashabc", payload);
        expect(lastCall(spy)).toMatchObject({
            url: "https://www.googleapis.com/calendar/v3/calendars/cal/events/dashabc",
            method: "PUT",
            body: { id: "dashabc", status: "confirmed" },
        });
    });

    it("deletes events and calendars", async () => {
        const spy = mockFetch(204);
        await deleteEvent("tok", "cal", "dashabc");
        expect(lastCall(spy)).toMatchObject({ method: "DELETE", url: expect.stringContaining("/events/dashabc") });
        await deleteCalendar("tok", "cal");
        expect(lastCall(spy)).toMatchObject({ method: "DELETE", url: expect.stringMatching(/calendars\/cal$/) });
    });

    it("throws a typed error carrying status and Google's reason", async () => {
        mockFetch(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } });
        const err = await insertEvent("tok", "cal", "id", payload).catch((e) => e);
        expect(err).toBeInstanceOf(GoogleApiError);
        expect(err).toMatchObject({ status: 403, reason: "rateLimitExceeded" });

        mockFetch(409, { error: { status: "ALREADY_EXISTS" } });
        expect(await insertEvent("tok", "cal", "id", payload).catch((e) => e)).toMatchObject({
            status: 409,
            reason: "ALREADY_EXISTS",
        });
    });
});

describe("google reads", () => {
    it("surfaces the dash task id on events dash wrote", async () => {
        mockFetch(200, {
            items: [
                {
                    id: "e1",
                    summary: "Mine",
                    start: { dateTime: "2026-08-04T17:00:00Z" },
                    end: { dateTime: "2026-08-04T17:30:00Z" },
                    extendedProperties: { private: { dashTaskId: "t1" } },
                },
                { id: "e2", summary: "Theirs", start: { date: "2026-08-05" }, end: { date: "2026-08-06" } },
            ],
        });
        const events = await listEvents("tok", "cal", "2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z");
        expect(events.map((e) => e.dashTaskId)).toEqual(["t1", undefined]);
    });
});
