import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as service from "../worker/service.ts";
import { ServiceError } from "../worker/service.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

/**
 * The service layer is callable without an HTTP request, so these exercise it
 * directly. The HTTP tests below then confirm index.ts maps ServiceError onto
 * the right status via app.onError().
 */
describe("service layer", () => {
    it("rejects empty quick-add text", async () => {
        await expect(service.quickAddTask(stub("s1"), "  ", "UTC")).rejects.toThrow(ServiceError);
    });

    it("rejects text that parses to nothing but tokens", async () => {
        await expect(service.quickAddTask(stub("s2"), "p1 tomorrow", "UTC")).rejects.toMatchObject({
            status: 400,
            message: "task has no content",
        });
    });

    it("404s completing a task that does not exist", async () => {
        await expect(service.completeTask(stub("s3"), "no-such-id")).rejects.toMatchObject({
            status: 404,
        });
    });

    it("refuses to delete the Inbox", async () => {
        await expect(service.deleteProject(stub("s4"), "inbox")).rejects.toMatchObject({
            status: 400,
        });
    });

    it("rejects a non-ISO calendar window", async () => {
        await expect(service.calendarItems(stub("s5"), "soon", "later")).rejects.toMatchObject({
            status: 400,
        });
    });

    it("creates a task end to end", async () => {
        const { task, parsed } = await service.quickAddTask(
            stub("s6"),
            "Write specs #Work p1 tomorrow at 3pm",
            "America/Chicago",
        );
        expect(task.content).toBe("Write specs");
        expect(task.priority).toBe(1);
        expect(parsed.due?.time).toBe("15:00");
    });
});

describe("tasks added from inside a project", () => {
    it("go to that project, unless the text names another with #", async () => {
        const s = stub("s-in-project");
        const work = await s.createProject("Work");
        const home = await s.createProject("Home");

        const plain = await service.quickAddTask(s, "Write specs tomorrow", "UTC", undefined, work.id);
        expect(plain.task.projectId).toBe(work.id);

        const tagged = await service.quickAddTask(s, "Water plants #Home", "UTC", undefined, work.id);
        expect(tagged.task.projectId).toBe(home.id);

        await expect(service.quickAddTask(s, "Orphan", "UTC", undefined, "nope")).rejects.toMatchObject({ status: 400 });
    });

    it("applies to pasted lines too, line by line", async () => {
        const s = stub("s-import-project");
        const work = await s.createProject("Work");
        const home = await s.createProject("Home");

        const { created } = await service.importTasks(s, "Write specs\nWater plants #Home", "UTC", work.id);
        expect(created.map((t) => t.projectId)).toEqual([work.id, home.id]);
    });
});

describe("ServiceError maps to HTTP status", () => {
    it("400 for an empty quick add", async () => {
        const res = await SELF.fetch("https://example.com/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "" }),
        });
        expect(res.status).toBe(400);
        expect((await res.json<{ error: string }>()).error).toBe("text: is required");
    });

    const send = (method: string, path: string, body: unknown) =>
        SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("400 for a blank project name", async () => {
        expect((await send("POST", "/api/projects", { name: "  " })).status).toBe(400);
    });

    it("400 for an unknown time zone", async () => {
        expect((await send("PATCH", "/api/preferences", { timeZone: "Mars/Base" })).status).toBe(400);
        expect((await send("PATCH", "/api/preferences", { timeZone: "Europe/Paris" })).status).toBe(200);
    });

    it("400 for moving a task to a project that does not exist", async () => {
        const created = await send("POST", "/api/tasks", { text: "move me" });
        const { task } = await created.json<{ task: { id: string } }>();
        const res = await send("PATCH", `/api/tasks/${task.id}`, { projectId: "nope" });
        expect(res.status).toBe(400);
        expect((await res.json<{ error: string }>()).error).toBe("project not found");
    });

    it("404 for pinning a missing project", async () => {
        expect((await send("PATCH", "/api/projects/nope/pinned", { pinned: true })).status).toBe(404);
    });

    it("404 for completing a missing task", async () => {
        const res = await SELF.fetch("https://example.com/api/tasks/nope/complete", {
            method: "POST",
        });
        expect(res.status).toBe(404);
    });

    it("400 for deleting the Inbox", async () => {
        const res = await SELF.fetch("https://example.com/api/projects/inbox", { method: "DELETE" });
        expect(res.status).toBe(400);
    });
});

describe("projects over HTTP", () => {
    it("creates a project", async () => {
        const res = await SELF.fetch("https://example.com/api/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Launch" }),
        });
        expect(res.status).toBe(201);
        const { project } = await res.json<{ project: { name: string; isInbox: boolean } }>();
        expect(project.name).toBe("Launch");
        expect(project.isInbox).toBe(false);
    });

    it("pins and unpins a project", async () => {
        const create = await SELF.fetch("https://example.com/api/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Pin me" }),
        });
        const { project } = await create.json<{ project: { id: string } }>();

        const res = await SELF.fetch(`https://example.com/api/projects/${project.id}/pinned`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pinned: true }),
        });
        expect(res.status).toBe(200);
        expect((await res.json<{ project: { pinned: boolean } }>()).project.pinned).toBe(true);
    });

    it("404s pinning a project that does not exist", async () => {
        const res = await SELF.fetch("https://example.com/api/projects/ghost/pinned", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pinned: true }),
        });
        expect(res.status).toBe(404);
    });

    it("rejects a non-boolean pinned value", async () => {
        const res = await SELF.fetch("https://example.com/api/projects/inbox/pinned", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pinned: "yes" }),
        });
        expect(res.status).toBe(400);
    });
});

describe("preferences validation", () => {
    const patchPrefs = (body: unknown) =>
        SELF.fetch("https://example.com/api/preferences", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("rejects an unknown dateFormat", async () => {
        expect((await patchPrefs({ dateFormat: "YMD" })).status).toBe(400);
    });

    it("takes a list of hidden Inbox projects, and rejects anything else", async () => {
        expect((await patchPrefs({ inboxHiddenProjects: "abc" })).status).toBe(400);
        expect((await patchPrefs({ inboxHiddenProjects: [1, 2] })).status).toBe(400);
        expect((await patchPrefs({ inboxHiddenGoals: "g1" })).status).toBe(400);
        const ok = await patchPrefs({ inboxHiddenProjects: ["p1"] });
        expect(ok.status).toBe(200);
        expect((await ok.json<{ preferences: { inboxHiddenProjects: string[] } }>()).preferences.inboxHiddenProjects).toEqual(["p1"]);
    });

    it("trims a name and rejects a blank one", async () => {
        expect((await patchPrefs({ firstName: "   " })).status).toBe(400);
        const ok = await patchPrefs({ firstName: "  Bill ", lastName: "Wang" });
        expect((await ok.json<{ preferences: { firstName: string } }>()).preferences.firstName).toBe("Bill");
    });

    // Generic body() helper behavior -- malformed JSON, not preferences-specific.
    it("rejects a body that is not JSON at all", async () => {
        const res = await SELF.fetch("https://example.com/api/preferences", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: "not json",
        });
        expect(res.status).toBe(400);
    });

    it("still accepts a valid partial update", async () => {
        const res = await patchPrefs({ timeZone: "America/Chicago" });
        expect(res.status).toBe(200);
        const { preferences } = await res.json<{ preferences: { timeZone: string } }>();
        expect(preferences.timeZone).toBe("America/Chicago");
    });
});

describe("bulk import over HTTP", () => {
    const post = (text: string) =>
        SELF.fetch("https://example.com/api/tasks/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, timeZone: "America/Chicago" }),
        });

    it("parses each line, creating tasks and projects once", async () => {
        const res = await post(
            "Review specs #ImportWork p1 tomorrow at 5pm\n- Ship it #importwork\n\nBuy milk",
        );
        expect(res.status).toBe(201);

        const { created, skipped } = await res.json<{
            created: { content: string; projectId: string; priority: number; due: { time: string } | null }[];
            skipped: unknown[];
        }>();
        expect(created.map((t) => t.content)).toEqual(["Review specs", "Ship it", "Buy milk"]);
        expect(created[0]).toMatchObject({ priority: 1, due: { time: "17:00" } });
        expect(created[0].projectId).toBe(created[1].projectId);
        expect(created[2].projectId).toBe("inbox");
        expect(skipped).toEqual([]);
    });

    it("skips lines that parse to no content instead of failing the batch", async () => {
        const res = await post("p1 tomorrow\nReal task");
        expect(res.status).toBe(201);
        const { created, skipped } = await res.json<{
            created: { content: string }[];
            skipped: { line: string; reason: string }[];
        }>();
        expect(created.map((t) => t.content)).toEqual(["Real task"]);
        expect(skipped).toEqual([{ line: "p1 tomorrow", reason: "no content" }]);
    });

    it("400 for an empty import and for too many lines", async () => {
        expect((await post("  \n \n")).status).toBe(400);
        const many = Array.from({ length: 501 }, (_, i) => `task ${i}`).join("\n");
        expect((await post(many)).status).toBe(400);
    });
});

describe("trash over HTTP", () => {
    const call = (method: string, path: string, body?: unknown) =>
        SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it("deleting a project trashes it, and restoring brings it and its tasks back", async () => {
        const added = await call("POST", "/api/tasks", { text: "Plan trip #TrashHttp" });
        const { task } = await added.json<{ task: { id: string; projectId: string } }>();

        expect((await call("DELETE", `/api/projects/${task.projectId}`)).status).toBe(204);
        const trash = await (await call("GET", "/api/trash")).json<{
            projects: { id: string; name: string; taskCount: number }[];
        }>();
        expect(trash.projects.find((p) => p.id === task.projectId)).toMatchObject({
            name: "TrashHttp",
            taskCount: 1,
        });

        // A trashed project can't be a move target.
        const other = await call("POST", "/api/tasks", { text: "other" });
        const { task: o } = await other.json<{ task: { id: string } }>();
        expect((await call("PATCH", `/api/tasks/${o.id}`, { projectId: task.projectId })).status).toBe(400);

        expect((await call("POST", `/api/trash/projects/${task.projectId}/restore`)).status).toBe(200);
        const state = await (await call("GET", "/api/state")).json<{
            tasks: { id: string }[];
        }>();
        expect(state.tasks.map((t) => t.id)).toContain(task.id);
    });

    it("409 for restoring a project whose name is taken", async () => {
        const first = await call("POST", "/api/projects", { name: "Clash" });
        const { project } = await first.json<{ project: { id: string } }>();
        await call("DELETE", `/api/projects/${project.id}`);
        await call("POST", "/api/projects", { name: "clash" });

        const res = await call("POST", `/api/trash/projects/${project.id}/restore`);
        expect(res.status).toBe(409);
        expect((await res.json<{ error: string }>()).error).toBe('A project named "Clash" already exists');
    });

    it("404 for restoring something that is not in the trash", async () => {
        expect((await call("POST", "/api/trash/projects/nope/restore")).status).toBe(404);
        expect((await call("POST", "/api/trash/tasks/nope/restore")).status).toBe(404);
    });
});

describe("adding to a project over HTTP", () => {
    it("files a quick-add into the project named by projectId", async () => {
        const post = (path: string, body: unknown) =>
            SELF.fetch(`https://example.com${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        const project = (await (await post("/api/projects", { name: "HttpWork" })).json()) as { project: { id: string } };
        const res = await post("/api/tasks", { text: "Draft memo", projectId: project.project.id });
        expect(res.status).toBe(201);
        expect(((await res.json()) as { task: { projectId: string } }).task.projectId).toBe(project.project.id);
    });
});
