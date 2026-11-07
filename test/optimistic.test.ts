import { describe, expect, it, vi } from "vitest";
import { parseQuickAdd } from "../shared/parser.ts";
import type { AppState, Task } from "../shared/types.ts";
import { optimistically, rescheduled, withCompleted, withUncompleted } from "../src/optimistic.ts";

const task = (over: Partial<Task> = {}): Task => ({
    id: "t1",
    content: "Water plants",
    description: "",
    projectId: "p1",
    priority: 4,
    due: null,
    deadline: null,
    durationMinutes: null,
    goalId: "g1",
    completed: false,
    completedAt: null,
    order: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
});

const stateWith = (tasks: Task[]) =>
    ({
        tasks,
        projects: [],
        habits: [],
        goals: [{ id: "g1", stepsDone: 2 }],
        preferences: { timeZone: "UTC" },
        completedThisWeek: 5,
        completedThisWeekByProject: { p1: 3 },
        user: { id: "u1", email: "u1@example.com", name: null, isAdmin: false },
    }) as unknown as AppState;

describe("optimistically", () => {
    it("takes in the server's answer and clears the notice", async () => {
        const onSaved = vi.fn();
        const rollback = vi.fn();
        const notify = vi.fn();
        await optimistically(async () => "saved", onSaved, rollback, notify);
        expect(onSaved).toHaveBeenCalledWith("saved");
        expect(notify).toHaveBeenCalledWith(null);
        expect(rollback).not.toHaveBeenCalled();
    });

    it("rolls back and says why when the save fails", async () => {
        const onSaved = vi.fn();
        const rollback = vi.fn();
        const notify = vi.fn();
        await optimistically(() => Promise.reject(new Error("offline")), onSaved, rollback, notify);
        expect(rollback).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledWith("offline");
        expect(onSaved).not.toHaveBeenCalled();
    });
});

describe("rescheduled", () => {
    const recurring = (text: string, date: string) =>
        task({ due: { ...parseQuickAdd(text, { timeZone: "UTC" }).due!, date } });

    it("moves a recurring task on from its scheduled date", () => {
        expect(rescheduled(recurring("Water plants every day", "2026-08-01"), "2026-08-04").due?.date).toBe("2026-08-02");
    });

    it("counts an every! task from the day it was done", () => {
        expect(rescheduled(recurring("Water plants every! 3 days", "2026-08-01"), "2026-08-04").due?.date).toBe("2026-08-07");
    });

    it("keeps the time and the rule", () => {
        const before = recurring("Water plants every day at 9am", "2026-08-01");
        expect(rescheduled(before, "2026-08-01").due).toEqual({ ...before.due, date: "2026-08-02" });
    });
});

describe("withUncompleted", () => {
    const today = "2026-08-05"; // a Wednesday

    it("undoes withCompleted: the task is back and the counts and goal steps are as they were", () => {
        const before = stateWith([task()]);
        const done = withCompleted(before, task());
        const undone = withUncompleted(done, task({ completed: true, completedAt: "2026-08-05T09:00:00.000Z" }), today);
        expect(undone.tasks).toEqual([task()]);
        expect(undone.completedThisWeek).toBe(before.completedThisWeek);
        expect(undone.completedThisWeekByProject).toEqual(before.completedThisWeekByProject);
        expect(undone.goals).toEqual(before.goals);
    });

    it("leaves this week's counts alone for a task finished in an earlier week", () => {
        const before = stateWith([]);
        const undone = withUncompleted(before, task({ completed: true, completedAt: "2026-08-02T09:00:00.000Z" }), today);
        expect(undone.tasks.map((t) => t.id)).toEqual(["t1"]);
        expect(undone.completedThisWeek).toBe(before.completedThisWeek);
        expect(undone.completedThisWeekByProject).toEqual(before.completedThisWeekByProject);
        expect(undone.goals[0].stepsDone).toBe(before.goals[0].stepsDone - 1);
    });
});
