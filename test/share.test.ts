import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SharedView } from "../shared/share.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

/** A shared project on a fresh user, with its token. */
async function shared(user: string, limit?: number) {
    const s = stub(user);
    const project = await s.createProject("Garden");
    const info = (await s.enableShare(project.id))!;
    if (limit) await s.setShareLimit(project.id, limit);
    return { s, project, token: info.token! };
}

describe("share links in the DO", () => {
    it("is off until enabled, and keeps its token when enabled again", async () => {
        const s = stub("sh-on");
        const p = await s.createProject("Garden");
        expect(await s.getShare(p.id)).toMatchObject({ enabled: false, token: null, limit: 25, usedToday: 0 });

        const first = await s.enableShare(p.id);
        expect(first!.token).toMatch(/^[0-9a-f-]{36}$/);
        expect((await s.enableShare(p.id))!.token).toBe(first!.token);
    });

    it("never shares the Inbox", async () => {
        const s = stub("sh-inbox");
        expect(await s.getShare("inbox")).toBeNull();
        expect(await s.enableShare("inbox")).toBeNull();
    });

    it("rotating kills the old token; turning off kills them all", async () => {
        const { s, project, token } = await shared("sh-rotate");
        const next = (await s.rotateShare(project.id))!.token!;
        expect(next).not.toBe(token);
        expect(await s.sharedView(token)).toBeNull();
        expect(await s.sharedView(next)).toMatchObject({ projectName: "Garden" });

        await s.disableShare(project.id);
        expect(await s.sharedView(next)).toBeNull();
        expect(await s.sharedView("")).toBeNull();
    });

    it("shows only the project's open tasks, marking those added through the link", async () => {
        const { s, project, token } = await shared("sh-view");
        await s.createTask({ content: "Mine", projectId: project.id });
        await s.createTask({ content: "Elsewhere" });
        const done = await s.createTask({ content: "Finished", projectId: project.id });
        await s.completeTask(done.id, "2026-01-01");
        await s.addShared(token, "Theirs");

        const view = (await s.sharedView(token))!;
        expect(view.tasks.map((t) => [t.content, t.viaLink])).toEqual([
            ["Mine", false],
            ["Theirs", true],
        ]);
    });

    it("keeps tasks added through the link on the page once ticked off, below the open ones", async () => {
        const { s, project, token } = await shared("sh-done");
        const mine = await s.createTask({ content: "Mine", projectId: project.id });
        const theirs = (await s.addShared(token, "Theirs")) as { id: string };
        await s.addShared(token, "Later");

        await s.completeShared(token, theirs.id);
        await s.completeTask(mine.id, "2026-01-01");

        const view = (await s.sharedView(token))!;
        expect(view.tasks.map((t) => [t.content, t.completed])).toEqual([
            ["Later", false],
            ["Theirs", true],
        ]);
    });

    it("adds plain text without parsing it, into the shared project", async () => {
        const { s, project, token } = await shared("sh-add");
        const task = await s.addShared(token, "Call Bob #Work p1 tomorrow");
        expect(task).toMatchObject({ content: "Call Bob #Work p1 tomorrow", projectId: project.id, priority: 4, due: null });
        expect((await s.listProjects()).map((p) => p.name)).not.toContain("Work");
        expect(await s.addShared("nope", "x")).toBeNull();
    });

    it("stops at the daily limit, and deleting what was added does not free a slot", async () => {
        const { s, project, token } = await shared("sh-limit", 2);
        const a = await s.addShared(token, "one");
        await s.addShared(token, "two");
        expect(await s.addShared(token, "three")).toBe("limit");
        expect((await s.sharedView(token))!.remaining).toBe(0);

        await s.deleteTask((a as { id: string }).id);
        expect(await s.addShared(token, "four")).toBe("limit");

        await s.setShareLimit(project.id, 3);
        expect(await s.addShared(token, "five")).toMatchObject({ content: "five" });
    });

    it("ticks off only this project's tasks", async () => {
        const { s, project, token } = await shared("sh-complete");
        const mine = await s.createTask({ content: "Mine", projectId: project.id });
        const other = await s.createTask({ content: "Elsewhere" });

        expect(await s.completeShared(token, other.id)).toBeNull();
        expect((await s.getTask(other.id))!.completed).toBe(false);
        expect(await s.completeShared("nope", mine.id)).toBeNull();
        expect(await s.completeShared(token, mine.id)).toMatchObject({ completed: true });
        // Another visitor got there first: not an error.
        expect(await s.completeShared(token, mine.id)).toMatchObject({ completed: true });
    });

    it("stops serving a trashed project", async () => {
        const { s, project, token } = await shared("sh-trash");
        await s.deleteProject(project.id);
        expect(await s.sharedView(token)).toBeNull();
        expect(await s.getShare(project.id)).toBeNull();
    });
});

describe("share links over HTTP", () => {
    const owner = (path: string, init?: RequestInit) =>
        SELF.fetch(`https://example.com${path}`, { ...init, headers: { "content-type": "application/json" } });

    /** Creates a project through the API as the dev user and shares it; returns the visitor base path. */
    async function shareViaApi(limit?: number) {
        const { project } = (await (await owner("/api/projects", { method: "POST", body: JSON.stringify({ name: `P${Math.random()}` }) })).json()) as { project: { id: string } };
        const res = await owner(`/api/projects/${project.id}/share`, { method: "PUT" });
        const { share } = (await res.json()) as { share: { url: string } };
        if (limit) await owner(`/api/projects/${project.id}/share`, { method: "PATCH", body: JSON.stringify({ limit }) });
        return { project, url: new URL(share.url), share };
    }

    it("builds a link that does not contain the user's identity", async () => {
        const { url } = await shareViaApi();
        expect(url.pathname).toMatch(/^\/s\/[0-9a-f]{64}\.[0-9a-f-]{36}$/);
        expect(url.pathname).not.toContain("test-user");
    });

    it("lets a visitor view, add and tick off without signing in, with private headers", async () => {
        const { url } = await shareViaApi();
        const visit = (path: string, init?: RequestInit) =>
            SELF.fetch(`https://example.com${url.pathname}${path}`, { ...init, headers: { "content-type": "application/json" } });

        const data = await visit("/data");
        expect(data.status).toBe(200);
        expect(data.headers.get("referrer-policy")).toBe("no-referrer");
        expect(data.headers.get("cache-control")).toBe("no-store");

        const added = await visit("/tasks", { method: "POST", body: JSON.stringify({ text: "Hello" }) });
        expect(added.status).toBe(201);
        const { task } = (await added.json()) as { task: { id: string } };
        expect(((await (await visit("/data")).json()) as SharedView).tasks.map((t) => t.content)).toEqual(["Hello"]);

        expect((await visit(`/tasks/${task.id}/complete`, { method: "POST" })).status).toBe(204);
        const after = ((await (await visit("/data")).json()) as SharedView).tasks;
        expect(after.map((t) => [t.content, t.completed])).toEqual([["Hello", true]]);
    });

    it("answers 429 at the limit and 404 for a rotated, malformed or foreign link", async () => {
        const { project, url } = await shareViaApi(1);
        const visit = (base: string, path: string, init?: RequestInit) =>
            SELF.fetch(`https://example.com${base}${path}`, { ...init, headers: { "content-type": "application/json" } });
        const add = (base: string) => visit(base, "/tasks", { method: "POST", body: JSON.stringify({ text: "x" }) });

        expect((await add(url.pathname)).status).toBe(201);
        expect((await add(url.pathname)).status).toBe(429);

        const [doId] = url.pathname.slice(3).split(".");
        expect((await visit(`/s/${doId}.${crypto.randomUUID()}`, "/data")).status).toBe(404);
        expect((await visit("/s/garbage", "/data")).status).toBe(404);
        expect((await visit(`/s/${"0".repeat(64)}.${crypto.randomUUID()}`, "/data")).status).toBe(404);

        await owner(`/api/projects/${project.id}/share/rotate`, { method: "POST" });
        expect((await visit(url.pathname, "/data")).status).toBe(404);
    });

    it("keeps the owner endpoints behind sign-in's gate and rejects a bad limit", async () => {
        const { project } = await shareViaApi();
        const bad = await owner(`/api/projects/${project.id}/share`, { method: "PATCH", body: JSON.stringify({ limit: 0 }) });
        expect(bad.status).toBe(400);
        expect((await owner("/api/projects/nope/share")).status).toBe(404);
    });
});
