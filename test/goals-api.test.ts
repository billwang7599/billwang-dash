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

describe("goal steps", () => {
    it("links a task to a goal, and deleting the goal keeps the task unlinked", async () => {
        const s = stub("g-steps");
        const goal = await s.createGoal(books);
        const step = await s.createTask({ content: "Buy Dune", goalId: goal.id });
        expect(step.goalId).toBe(goal.id);

        const plain = await s.updateTask(step.id, { goalId: null });
        expect(plain?.goalId).toBeNull();
        await s.updateTask(step.id, { goalId: goal.id });

        await s.deleteGoal(goal.id);
        const [after] = (await s.listTasks()).filter((t) => t.id === step.id);
        expect(after).toMatchObject({ content: "Buy Dune", goalId: null });
    });
});

describe("completed tasks", () => {
    it("pages newest first, counts this week, and counts a goal's done steps", async () => {
        const s = stub("g-completed");
        const goal = await s.createGoal(books);
        const a = await s.createTask({ content: "A", goalId: goal.id });
        const b = await s.createTask({ content: "B" });
        const c = await s.createTask({ content: "C", goalId: goal.id });
        await s.createTask({ content: "still open" });
        const today = new Date().toISOString().slice(0, 10);
        for (const t of [a, b, c]) {
            await s.completeTask(t.id, today);
            await new Promise((r) => setTimeout(r, 5)); // distinct completedAt
        }

        const first = await s.listCompletedTasks(null, 2);
        expect(first.tasks.map((t) => t.content)).toEqual(["C", "B"]);
        expect(first.more).toBe(true);
        const second = await s.listCompletedTasks(first.tasks[1].completedAt, 2);
        expect(second.tasks.map((t) => t.content)).toEqual(["A"]);
        expect(second.more).toBe(false);

        expect(await s.countCompletedThisWeek()).toBe(3);
        expect((await s.listGoals())[0].stepsDone).toBe(2);

        await s.uncompleteTask(c.id);
        expect((await s.listGoals())[0].stepsDone).toBe(1);
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

    it("adds steps through quick-add and the task editor, checking the goal exists", async () => {
        const { goal } = await (await call("POST", "/api/goals", books)).json<{ goal: { id: string } }>();

        const added = await call("POST", "/api/tasks", { text: "Buy Dune tomorrow", goalId: goal.id });
        expect(added.status).toBe(201);
        const { task } = await added.json<{ task: { id: string; goalId: string; due: object | null } }>();
        expect(task.goalId).toBe(goal.id);
        expect(task.due).not.toBeNull(); // still parsed as quick-add

        expect((await call("POST", "/api/tasks", { text: "X", goalId: "nope" })).status).toBe(400);
        expect((await call("PATCH", `/api/tasks/${task.id}`, { goalId: "nope" })).status).toBe(400);

        const cleared = await call("PATCH", `/api/tasks/${task.id}`, { goalId: null });
        expect((await cleared.json<{ task: { goalId: string | null } }>()).task.goalId).toBeNull();
    });

    it("lists completed tasks and rejects a bad cursor", async () => {
        const res = await call("GET", "/api/tasks/completed");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ tasks: expect.any(Array), more: expect.any(Boolean) });
        expect((await call("GET", "/api/tasks/completed?before=nope")).status).toBe(400);
        const state = await (await call("GET", "/api/state")).json<{ completedThisWeek: number }>();
        expect(typeof state.completedThisWeek).toBe("number");
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
