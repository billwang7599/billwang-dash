import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GoalInput } from "../shared/goals.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

const books: GoalInput = {
    title: "Read 12 books",
    why: "",
    horizon: "medium",
    target: 12,
    current: 0,
    unit: "books",
    deadline: "2027-06-30",
};

describe("goal storage", () => {
    it("creates, lists by deadline, updates, records progress, and deletes", async () => {
        const s = stub("g-crud");
        const later = await s.createGoal(books);
        const sooner = await s.createGoal({ ...books, title: "Run a 10k", horizon: "short", deadline: "2026-11-30" });
        expect((await s.listGoals()).map((g) => g.id)).toEqual([sooner.id, later.id]);

        const edited = await s.updateGoal(later.id, { ...books, target: 20 });
        expect(edited).toMatchObject({ target: 20, current: 0 });

        expect(await s.setGoalProgress(later.id, 5.5)).toMatchObject({ current: 5.5 });

        await s.deleteGoal(later.id);
        expect((await s.listGoals()).map((g) => g.id)).toEqual([sooner.id]);
    });

    it("stores a yes/no goal with no target", async () => {
        const s = stub("g-yesno");
        const g = await s.createGoal({ ...books, title: "Read Dune", target: null, unit: "" });
        expect(g.target).toBeNull();
        expect(await s.setGoalProgress(g.id, 1)).toMatchObject({ target: null, current: 1 });
    });

    it("returns null for a missing goal", async () => {
        const s = stub("g-missing");
        expect(await s.updateGoal("nope", books)).toBeNull();
        expect(await s.setGoalProgress("nope", 1)).toBeNull();
    });
});

describe("goals over HTTP", () => {
    const call = (method: string, path: string, body?: unknown) =>
        SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it("creates, shows up in /api/state, records progress, and deletes", async () => {
        const created = await call("POST", "/api/goals", { title: "Save $5k", horizon: "long", target: 5000, deadline: "2028-01-01" });
        expect(created.status).toBe(201);
        const { goal } = await created.json<{ goal: { id: string; current: number } }>();
        expect(goal.current).toBe(0);

        const state = await (await call("GET", "/api/state")).json<{ goals: { id: string }[] }>();
        expect(state.goals.some((g) => g.id === goal.id)).toBe(true);

        const stepped = await call("PUT", `/api/goals/${goal.id}/progress`, { current: 250 });
        expect(stepped.status).toBe(200);
        expect((await stepped.json<{ goal: { current: number } }>()).goal.current).toBe(250);

        expect((await call("DELETE", `/api/goals/${goal.id}`)).status).toBe(204);
        expect((await call("PATCH", `/api/goals/${goal.id}`, books)).status).toBe(404);
    });

    it("rejects invalid bodies", async () => {
        expect((await call("POST", "/api/goals", { ...books, target: 0 })).status).toBe(400);
        expect((await call("POST", "/api/goals", { ...books, deadline: "soon" })).status).toBe(400);
        expect((await call("PUT", "/api/goals/x/progress", { current: -1 })).status).toBe(400);
    });

    it("404 for a missing goal", async () => {
        expect((await call("PATCH", "/api/goals/nope", books)).status).toBe(404);
        expect((await call("PUT", "/api/goals/nope/progress", { current: 1 })).status).toBe(404);
    });
});
