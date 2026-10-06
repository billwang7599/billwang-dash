import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (name: string) => env.USER_DO.getByName(name);

describe("UserDO storage", () => {
    it("starts every user with an Inbox", async () => {
        const projects = await stub("u1").listProjects();
        expect(projects).toHaveLength(1);
        expect(projects[0]).toMatchObject({ id: "inbox", name: "Inbox", isInbox: true });
    });

    it("files a task without a project into the Inbox", async () => {
        const task = await stub("u2").createTask({ content: "Buy milk" });
        expect(task.projectId).toBe("inbox");
        expect(task.priority).toBe(4);
    });

    it("creates a referenced project on the fly", async () => {
        const s = stub("u3");
        const task = await s.createTask({ content: "Ship it", projectName: "Work" });

        const projects = await s.listProjects();
        expect(projects.map((p) => p.name)).toContain("Work");
        expect(task.projectId).not.toBe("inbox");
    });

    it("reuses an existing project rather than duplicating it", async () => {
        const s = stub("u4");
        await s.createTask({ content: "A", projectName: "Work" });
        await s.createTask({ content: "B", projectName: "work" });
        expect((await s.listProjects()).filter((p) => !p.isInbox)).toHaveLength(1);
    });

    it("stamps a new project with its creation time", async () => {
        const before = new Date().toISOString();
        const project = await stub("u5").createProject("Launch");
        expect(project.createdAt >= before).toBe(true);
        expect(project.createdAt <= new Date().toISOString()).toBe(true);
    });

    it("starts a new project unpinned, and pins/unpins on request", async () => {
        const s = stub("u6");
        const project = await s.createProject("Launch");
        expect(project.pinned).toBe(false);

        const pinned = await s.setProjectPinned(project.id, true);
        expect(pinned?.pinned).toBe(true);

        const unpinned = await s.setProjectPinned(project.id, false);
        expect(unpinned?.pinned).toBe(false);
    });

    it("returns null pinning a project that does not exist", async () => {
        expect(await stub("u7").setProjectPinned("ghost", true)).toBeNull();
    });

    it("round-trips due dates", async () => {
        const s = stub("u5");
        const created = await s.createTask({
            content: "Review",
            priority: 1,
            due: { date: "2026-08-04", time: "17:00", recurrence: null },
            durationMinutes: 90,
        });

        const [task] = await s.listTasks();
        expect(task.id).toBe(created.id);
        expect(task.due).toEqual({ date: "2026-08-04", time: "17:00", recurrence: null });
        expect(task.durationMinutes).toBe(90);
    });

    it("isolates users from each other", async () => {
        await stub("alice").createTask({ content: "Alice task" });
        expect(await stub("bob").listTasks()).toHaveLength(0);
    });
});

describe("completing tasks", () => {
    const recurrence = (over: Record<string, unknown> = {}) => ({
        freq: "daily" as const, interval: 1, weekdays: [], month: null,
        monthDay: null, fromCompletion: false, ...over,
    });

    it("closes a one-off task", async () => {
        const s = stub("c1");
        const task = await s.createTask({ content: "One off" });
        const done = await s.completeTask(task.id, "2026-08-03");

        expect(done?.completed).toBe(true);
        expect(done?.completedAt).not.toBeNull();
        expect(await s.listTasks()).toHaveLength(0);
    });

    it("rolls a recurring task forward instead of closing it", async () => {
        const s = stub("c2");
        const task = await s.createTask({
            content: "Vitamins",
            due: { date: "2026-08-03", time: null, recurrence: recurrence() },
        });

        const rolled = await s.completeTask(task.id, "2026-08-03");
        expect(rolled?.completed).toBe(false);
        expect(rolled?.due?.date).toBe("2026-08-04");
        expect(await s.listTasks()).toHaveLength(1);
    });

    it("counts a normal rule from the scheduled date, not today", async () => {
        const s = stub("c3");
        const task = await s.createTask({
            content: "Water plants",
            due: { date: "2026-08-01", time: null, recurrence: recurrence({ interval: 3 }) },
        });

        // Completed three days late; the next occurrence still follows the
        // original schedule rather than jumping from today.
        const rolled = await s.completeTask(task.id, "2026-08-04");
        expect(rolled?.due?.date).toBe("2026-08-04");
    });

    it("counts an `every!` rule from the completion date", async () => {
        const s = stub("c4");
        const task = await s.createTask({
            content: "Change filter",
            due: {
                date: "2026-08-01", time: null,
                recurrence: recurrence({ interval: 3, fromCompletion: true }),
            },
        });

        const rolled = await s.completeTask(task.id, "2026-08-04");
        expect(rolled?.due?.date).toBe("2026-08-07");
    });

    it("reopens a completed task", async () => {
        const s = stub("c5");
        const task = await s.createTask({ content: "Oops" });
        await s.completeTask(task.id, "2026-08-03");
        const reopened = await s.uncompleteTask(task.id);

        expect(reopened?.completed).toBe(false);
        expect(reopened?.completedAt).toBeNull();
    });
});

describe("quick add over HTTP", () => {
    it("parses the raw text server-side and stores the result", async () => {
        const res = await SELF.fetch("https://example.com/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                text: "Review specs #Work p1 tomorrow at 5pm",
                timeZone: "America/Chicago",
            }),
        });
        expect(res.status).toBe(201);

        const { task } = await res.json<{ task: { content: string; priority: number; due: { time: string } | null } }>();
        expect(task.content).toBe("Review specs");
        expect(task.priority).toBe(1);
        expect(task.due?.time).toBe("17:00");
    });

    it("rejects text that parses to no content", async () => {
        const res = await SELF.fetch("https://example.com/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "p1 tomorrow" }),
        });
        expect(res.status).toBe(400);
    });
});

describe("preferences", () => {
    it("persists timeZone and dateFormat", async () => {
        const s = stub("prefs1");
        await s.setPreferences({ timeZone: "America/Chicago", dateFormat: "DMY" });

        const prefs = await s.getPreferences();
        expect(prefs.timeZone).toBe("America/Chicago");
        expect(prefs.dateFormat).toBe("DMY");
    });

    it("shows every project in the Inbox until some are hidden, and dedupes the list", async () => {
        const s = stub("prefs-inbox");
        expect((await s.getPreferences()).inboxHiddenProjects).toEqual([]);

        await s.setPreferences({ inboxHiddenProjects: ["a", "b", "a"] });
        expect((await s.getPreferences()).inboxHiddenProjects).toEqual(["a", "b"]);

        // Other preference writes leave it alone.
        await s.setPreferences({ dateFormat: "DMY" });
        expect((await s.getPreferences()).inboxHiddenProjects).toEqual(["a", "b"]);

        await s.setPreferences({ inboxHiddenProjects: [] });
        expect((await s.getPreferences()).inboxHiddenProjects).toEqual([]);

        // Hidden goals are a separate list; setting one leaves the other alone.
        expect((await s.getPreferences()).inboxHiddenGoals).toEqual([]);
        await s.setPreferences({ inboxHiddenGoals: ["g1", "g1"] });
        expect(await s.getPreferences()).toMatchObject({ inboxHiddenGoals: ["g1"], inboxHiddenProjects: [] });
    });
});

describe("profile name", () => {
    it("starts empty (so setup asks for it) and saves each part on its own", async () => {
        const s = stub("prefs-name");
        expect(await s.getPreferences()).toMatchObject({ firstName: "", lastName: "" });

        await s.setPreferences({ firstName: "Bill", lastName: "Wang" });
        expect(await s.getPreferences()).toMatchObject({ firstName: "Bill", lastName: "Wang" });

        await s.setPreferences({ firstName: "William" });
        expect(await s.getPreferences()).toMatchObject({ firstName: "William", lastName: "Wang" });
    });
});

describe("time zone detection flag", () => {
    it("starts unset, and setting a zone marks it chosen", async () => {
        const s = stub("tzset1");
        expect(await s.getPreferences()).toMatchObject({ timeZone: "UTC", timeZoneSet: false });

        await s.setPreferences({ dateFormat: "DMY" });
        expect((await s.getPreferences()).timeZoneSet).toBe(false);

        await s.setPreferences({ timeZone: "UTC" });
        expect((await s.getPreferences()).timeZoneSet).toBe(true);
    });
});

describe("UserDO cascades", () => {
    it("deleting a project removes its tasks", async () => {
        const s = stub("cascade1");
        const task = await s.createTask({ content: "x", projectName: "Doomed" });
        expect(await s.deleteProject(task.projectId)).toBe(true);
        expect(await s.getTask(task.id)).toBeNull();
        expect(await s.listTasks({ includeCompleted: true })).toHaveLength(0);
    });
});

describe("UserDO trash", () => {
    const count = (name: string, table: "projects" | "tasks") =>
        runInDurableObject(stub(name), async (_i, state) =>
            state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
        );

    it("moves a deleted project and its tasks to the trash, out of every list", async () => {
        const s = stub("trash1");
        const a = await s.createTask({ content: "A", projectName: "Doomed" });
        await s.createTask({ content: "B", projectName: "Doomed" });
        await s.deleteProject(a.projectId);

        expect((await s.listProjects()).map((p) => p.name)).toEqual(["Inbox"]);
        expect(await s.listTasks({ includeCompleted: true })).toHaveLength(0);
        expect(await s.getTask(a.id)).toBeNull();

        const trash = await s.getTrash();
        expect(trash.projects).toMatchObject([{ name: "Doomed", taskCount: 2 }]);
        expect(trash.tasks).toHaveLength(0); // covered by the project row
    });

    it("restores a project with its tasks, but not tasks trashed earlier on their own", async () => {
        const s = stub("trash2");
        const keep = await s.createTask({ content: "keep", projectName: "P" });
        const early = await s.createTask({ content: "early", projectName: "P" });
        await s.deleteTask(early.id);
        await s.deleteProject(keep.projectId);

        expect(await s.restoreProject(keep.projectId)).toMatchObject({ project: { name: "P" } });
        expect((await s.listTasks()).map((t) => t.content)).toEqual(["keep"]);
        // The early one is now a standalone trashed task of a live project.
        expect((await s.getTrash()).tasks.map((t) => t.content)).toEqual(["early"]);
    });

    it("restores a single task, unless its project is still in the trash", async () => {
        const s = stub("trash3");
        const t = await s.createTask({ content: "x" });
        await s.deleteTask(t.id);
        expect((await s.getTrash()).tasks).toHaveLength(1);
        expect(await s.restoreTask(t.id)).toMatchObject({ content: "x" });
        expect((await s.getTrash()).tasks).toHaveLength(0);

        const inProject = await s.createTask({ content: "y", projectName: "Gone" });
        await s.deleteTask(inProject.id);
        await s.deleteProject(inProject.projectId);
        expect(await s.restoreTask(inProject.id)).toBeNull();
    });

    it("purges only what is already in the trash", async () => {
        const s = stub("trash4");
        const live = await s.createTask({ content: "live", projectName: "Live" });
        const dead = await s.createTask({ content: "dead", projectName: "Dead" });
        await s.deleteProject(dead.projectId);

        await s.purgeProject(live.projectId); // not trashed: no-op
        expect(await s.getTask(live.id)).not.toBeNull();

        await s.purgeProject(dead.projectId);
        expect((await s.getTrash()).projects).toHaveLength(0);
        // Cascade took the trashed task with it.
        expect(await count("trash4", "tasks")).toBe(1);
        expect(await count("trash4", "projects")).toBe(2); // Inbox + Live
    });

    it("empties the trash", async () => {
        const s = stub("trash5");
        const a = await s.createTask({ content: "a", projectName: "Q" });
        const b = await s.createTask({ content: "b" });
        await s.deleteTask(b.id);
        await s.deleteProject(a.projectId);
        await s.emptyTrash();
        expect(await s.getTrash()).toEqual({ projects: [], tasks: [] });
        expect(await count("trash5", "tasks")).toBe(0);
    });

    it("refuses to restore a project whose name a live project now has", async () => {
        const s = stub("trash8");
        const old = await s.createTask({ content: "a", projectName: "Work" });
        await s.deleteProject(old.projectId);
        await s.createTask({ content: "b", projectName: "work" });

        expect(await s.restoreProject(old.projectId)).toEqual({ error: "name_taken", name: "Work" });
        expect((await s.getTrash()).projects).toHaveLength(1);
        expect(await s.restoreProject("nope")).toEqual({ error: "not_found" });
    });

    it("ignores trashed projects when a new task names one", async () => {
        const s = stub("trash6");
        const first = await s.createTask({ content: "a", projectName: "Work" });
        await s.deleteProject(first.projectId);
        const second = await s.createTask({ content: "b", projectName: "Work" });
        expect(second.projectId).not.toBe(first.projectId);
        expect(await s.hasProject(first.projectId)).toBe(false);
    });

    it("keeps trashed tasks off the calendar", async () => {
        const s = stub("trash7");
        const t = await s.createTask({
            content: "gone",
            due: { date: "2026-08-05", time: null, recurrence: null },
        });
        await s.deleteTask(t.id);
        expect(await s.getCalendarItems("2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z")).toEqual([]);
    });
});
