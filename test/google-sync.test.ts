import { describe, expect, it } from "vitest";
import { GoogleApiError } from "../worker/google.ts";
import {
    backoffMs,
    classifyError,
    eventForTask,
    eventIdForTask,
    fingerprint,
} from "../worker/google-sync.ts";
import type { Task } from "../shared/types.ts";

const ORIGIN = "https://dash.example/";

const task = (over: Partial<Task> = {}): Task => ({
    id: "11111111-2222-3333-4444-555555555555",
    content: "Review specs",
    description: "",
    projectId: "inbox",
    priority: 4,
    due: { date: "2026-08-04", time: "17:00", recurrence: null },
    deadline: null,
    durationMinutes: null,
    completed: false,
    completedAt: null,
    order: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
});

describe("eventForTask", () => {
    it("makes a timed task a 30 minute event in the given zone", () => {
        const e = eventForTask(task(), "America/Chicago", ORIGIN)!;
        expect(e.start).toEqual({ dateTime: "2026-08-04T17:00:00", timeZone: "America/Chicago" });
        expect(e.end).toEqual({ dateTime: "2026-08-04T17:30:00", timeZone: "America/Chicago" });
        expect(e.summary).toBe("Review specs");
        expect(e.extendedProperties.private.dashTaskId).toBe(task().id);
    });

    it("uses the task's duration", () => {
        const e = eventForTask(task({ durationMinutes: 90 }), "UTC", ORIGIN)!;
        expect(e.end).toMatchObject({ dateTime: "2026-08-04T18:30:00" });
    });

    it("rolls the end into the next day when it passes midnight", () => {
        const e = eventForTask(
            task({ due: { date: "2026-08-31", time: "23:30", recurrence: null }, durationMinutes: 60 }),
            "UTC",
            ORIGIN,
        )!;
        expect(e.end).toMatchObject({ dateTime: "2026-09-01T00:30:00" });
    });

    it("makes a date-only task an all-day, free event ending the next day", () => {
        const e = eventForTask(task({ due: { date: "2026-12-31", time: null, recurrence: null } }), "UTC", ORIGIN)!;
        expect(e.start).toEqual({ date: "2026-12-31" });
        expect(e.end).toEqual({ date: "2027-01-01" });
        expect(e.transparency).toBe("transparent");
    });

    it("floats: the same task yields the same wall time under any zone", () => {
        const a = eventForTask(task(), "Asia/Tokyo", ORIGIN)!;
        const b = eventForTask(task(), "America/Chicago", ORIGIN)!;
        expect((a.start as { dateTime: string }).dateTime).toBe((b.start as { dateTime: string }).dateTime);
        expect((a.start as { timeZone: string }).timeZone).toBe("Asia/Tokyo");
    });

    it("has no event for a completed or undated task", () => {
        expect(eventForTask(task({ completed: true }), "UTC", ORIGIN)).toBeNull();
        expect(eventForTask(task({ due: null }), "UTC", ORIGIN)).toBeNull();
    });

    it("mirrors a recurring task as one event at its current date", () => {
        const recurrence = { freq: "daily" as const, interval: 1, weekdays: [], month: null, monthDay: null, fromCompletion: false };
        const e = eventForTask(task({ due: { date: "2026-08-05", time: null, recurrence } }), "UTC", ORIGIN)!;
        expect(e.start).toEqual({ date: "2026-08-05" });
        expect(JSON.stringify(e)).not.toContain("RRULE");
    });

    it("links back to dash in the description, after the task's own", () => {
        const e = eventForTask(task({ description: "Bring notes" }), "UTC", ORIGIN)!;
        expect(e.description).toBe("Bring notes\n\nOpen in dash: https://dash.example/app");
        expect(eventForTask(task(), "UTC", ORIGIN)!.description).toBe("Open in dash: https://dash.example/app");
    });
});

describe("eventIdForTask", () => {
    it("is deterministic and uses only base32hex characters", () => {
        const id = eventIdForTask(task().id);
        expect(id).toBe(eventIdForTask(task().id));
        expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    });

    it("is distinct per task", () => {
        expect(eventIdForTask(crypto.randomUUID())).not.toBe(eventIdForTask(crypto.randomUUID()));
    });
});

describe("fingerprint", () => {
    it("is stable for equal payloads regardless of key order, and changes with content", async () => {
        const e = eventForTask(task(), "UTC", ORIGIN)!;
        const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(e).reverse())));
        expect(await fingerprint(reordered)).toBe(await fingerprint(e));
        expect(await fingerprint({ ...e, summary: "Other" })).not.toBe(await fingerprint(e));
    });
});

describe("classifyError", () => {
    const api = (status: number, reason: string | null = null) => new GoogleApiError(status, reason, "x");

    it("sorts Google failures into what the sync should do next", () => {
        expect(classifyError(new TypeError("network"))).toBe("retry");
        expect(classifyError(api(429))).toBe("retry");
        expect(classifyError(api(503))).toBe("retry");
        expect(classifyError(api(403, "rateLimitExceeded"))).toBe("retry");
        expect(classifyError(api(403, "insufficientPermissions"))).toBe("reauth");
        expect(classifyError(api(401))).toBe("reauth");
        expect(classifyError(api(409))).toBe("conflict");
        expect(classifyError(api(404))).toBe("gone");
        expect(classifyError(api(410))).toBe("gone");
        expect(classifyError(api(400, "invalid"))).toBe("fatal");
    });
});

describe("backoffMs", () => {
    it("doubles from a minute and caps at an hour", () => {
        expect(backoffMs(0)).toBe(60_000);
        expect(backoffMs(1)).toBe(120_000);
        expect(backoffMs(20)).toBe(3_600_000);
    });
});
