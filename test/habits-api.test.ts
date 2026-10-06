import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { civilFromDate, civilKey, addDays } from "../shared/civil.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

/** A date in the DO's zone (UTC unless a test changes it), offset from today. */
const day = (offset = 0) => civilKey(addDays(civilFromDate(new Date(), "UTC"), offset));

const daily = { name: "Meditate", freq: "daily" as const, perWeek: null, weekdays: [] };

describe("habit storage", () => {
    it("creates a habit starting today, with empty stats", async () => {
        const s = stub("h-create");
        const h = await s.createHabit(daily);
        expect(h).toMatchObject({
            name: "Meditate",
            freq: "daily",
            startDate: day(),
            today: null,
            stats: { streak: 0, bestStreak: 0, streakUnit: "day", totalDone: 0, rate: null },
        });
        expect((await s.listHabits()).map((x) => x.id)).toEqual([h.id]);
    });

    it("checking in today starts a streak and is reflected in the summary", async () => {
        const s = stub("h-today");
        const h = await s.createHabit(daily);
        const after = await s.setHabitCheckin(h.id, day(), "done", undefined);
        expect(after).toMatchObject({ today: "done", stats: { streak: 1, totalDone: 1 } });

        const cleared = await s.setHabitCheckin(h.id, day(), null, undefined);
        expect(cleared).toMatchObject({ today: null, stats: { streak: 0, totalDone: 0 } });
    });

    it("logging an earlier day moves the start back and builds the streak from it", async () => {
        const s = stub("h-backfill");
        const h = await s.createHabit(daily);
        await s.setHabitCheckin(h.id, day(-2), "done", undefined);
        await s.setHabitCheckin(h.id, day(-1), "done", undefined);
        const after = await s.setHabitCheckin(h.id, day(), "done", undefined);
        expect(after).toMatchObject({ startDate: day(-2), stats: { streak: 3, bestStreak: 3 } });
    });

    it("keeps a note across status changes, and drops it with the check-in", async () => {
        const s = stub("h-note");
        const h = await s.createHabit(daily);
        await s.setHabitCheckin(h.id, day(), "done", "felt calm");
        await s.setHabitCheckin(h.id, day(), "skipped", undefined);
        const detail = await s.getHabitDetail(h.id, day().slice(0, 7));
        expect(detail!.days).toEqual([{ day: day(), status: "skipped", note: "felt calm" }]);

        await s.setHabitCheckin(h.id, day(), null, undefined);
        expect((await s.getHabitDetail(h.id, day().slice(0, 7)))!.days).toEqual([]);
    });

    it("returns only the requested month", async () => {
        const s = stub("h-month");
        const h = await s.createHabit(daily);
        await s.setHabitCheckin(h.id, "2025-01-31", "done", undefined);
        await s.setHabitCheckin(h.id, "2025-02-01", "done", undefined);
        const jan = await s.getHabitDetail(h.id, "2025-01");
        expect(jan!.days.map((d) => d.day)).toEqual(["2025-01-31"]);
        expect((await s.getHabitDetail(h.id, "2025-02"))!.days.map((d) => d.day)).toEqual(["2025-02-01"]);
    });

    it("edits the rule, and deleting removes the check-ins too", async () => {
        const s = stub("h-edit");
        const h = await s.createHabit(daily);
        await s.setHabitCheckin(h.id, day(), "done", undefined);

        const edited = await s.updateHabit(h.id, { name: "Run", freq: "weekly_count", perWeek: 3, weekdays: [] });
        expect(edited).toMatchObject({ name: "Run", freq: "weekly_count", perWeek: 3, stats: { streakUnit: "week" } });

        await s.deleteHabit(h.id);
        expect(await s.listHabits()).toEqual([]);
        const left = await runInDurableObject(s, async (_i, state) =>
            state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM habit_checkins").one().n,
        );
        expect(left).toBe(0);
    });

    it("answers null for a habit that does not exist", async () => {
        const s = stub("h-missing");
        expect(await s.updateHabit("nope", daily)).toBeNull();
        expect(await s.setHabitCheckin("nope", day(), "done", undefined)).toBeNull();
        expect(await s.getHabitDetail("nope", day().slice(0, 7))).toBeNull();
    });

    it("measures today in the user's zone", async () => {
        const s = stub("h-zone");
        await s.setPreferences({ timeZone: "Pacific/Kiritimati" }); // UTC+14, often a day ahead
        const h = await s.createHabit(daily);
        expect(h.startDate).toBe(civilKey(civilFromDate(new Date(), "Pacific/Kiritimati")));
    });
});

describe("habits over HTTP", () => {
    const call = (method: string, path: string, body?: unknown) =>
        SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it("creates, checks in, shows up in /api/state, and deletes", async () => {
        const created = await call("POST", "/api/habits", daily);
        expect(created.status).toBe(201);
        const { habit } = await created.json<{ habit: { id: string } }>();

        const done = await call("PUT", `/api/habits/${habit.id}/checkins/${day()}`, { status: "done" });
        expect(done.status).toBe(200);
        expect((await done.json<{ habit: { today: string } }>()).habit.today).toBe("done");

        const state = await (await call("GET", "/api/state")).json<{ habits: { id: string; today: string }[] }>();
        expect(state.habits.find((h) => h.id === habit.id)).toMatchObject({ today: "done" });

        const detail = await (await call("GET", `/api/habits/${habit.id}`)).json<{ days: unknown[]; month: string }>();
        expect(detail.month).toBe(day().slice(0, 7));
        expect(detail.days).toHaveLength(1);

        expect((await call("DELETE", `/api/habits/${habit.id}`)).status).toBe(204);
        expect((await call("GET", `/api/habits/${habit.id}`)).status).toBe(404);
    });

    it("validates the rule: N a week needs a count, weekdays need a day, and extras are dropped", async () => {
        expect((await call("POST", "/api/habits", { name: "X", freq: "weekly_count" })).status).toBe(400);
        expect((await call("POST", "/api/habits", { name: "X", freq: "weekdays", weekdays: [] })).status).toBe(400);
        expect((await call("POST", "/api/habits", { name: "  ", freq: "daily" })).status).toBe(400);
        expect((await call("POST", "/api/habits", { name: "X", freq: "weekly_count", perWeek: 8 })).status).toBe(400);

        const ok = await call("POST", "/api/habits", { name: "Gym", freq: "weekdays", weekdays: [5, 1, 3, 1], perWeek: 4 });
        expect(ok.status).toBe(201);
        expect((await ok.json<{ habit: object }>()).habit).toMatchObject({ weekdays: [1, 3, 5], perWeek: null });
    });

    it("rejects a future day, a malformed day, and a malformed month", async () => {
        const { habit } = await (await call("POST", "/api/habits", daily)).json<{ habit: { id: string } }>();
        expect((await call("PUT", `/api/habits/${habit.id}/checkins/${day(2)}`, { status: "done" })).status).toBe(400);
        expect((await call("PUT", `/api/habits/${habit.id}/checkins/2026-02-31`, { status: "done" })).status).toBe(400);
        expect((await call("PUT", `/api/habits/${habit.id}/checkins/${day()}`, { status: "nope" })).status).toBe(400);
        expect((await call("GET", `/api/habits/${habit.id}?month=2026-13`)).status).toBe(400);
    });

    it("404 for a missing habit", async () => {
        expect((await call("PATCH", "/api/habits/nope", daily)).status).toBe(404);
        expect((await call("PUT", `/api/habits/nope/checkins/${day()}`, { status: "done" })).status).toBe(404);
    });
});
