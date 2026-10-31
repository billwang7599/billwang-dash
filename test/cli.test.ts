import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SHOW_TASKS } from "../shared/chat.ts";
import { tools } from "../worker/ai/tools.ts";

const TOKEN = /^[0-9a-f]{64}\.[\w-]{43}$/;

const owner = (path: string, init?: RequestInit) =>
    SELF.fetch(`https://example.com${path}`, { ...init, headers: { "content-type": "application/json" } });

const cli = (token: string | null, path: string, body?: unknown) =>
    SELF.fetch(`https://example.com/cli${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

async function newToken() {
    const res = await owner("/api/cli-token", { method: "POST" });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
}

const secretOf = (token: string) => token.split(".")[1];

describe("CLI token in the DO", () => {
    it("keeps only a hash, and a new token replaces the old one", async () => {
        const s = env.USER_DO.getByName("cli-do");
        expect(await s.hasCliToken()).toBe(false);

        const first = await s.createCliToken();
        expect(first).toMatch(TOKEN);
        expect(first.split(".")[0]).toBe(env.USER_DO.idFromName("cli-do").toString());
        expect(await s.checkCliToken(secretOf(first))).toBe(true);

        const second = await s.createCliToken();
        expect(await s.checkCliToken(secretOf(first))).toBe(false);
        expect(await s.checkCliToken(secretOf(second))).toBe(true);

        await s.revokeCliToken();
        expect(await s.hasCliToken()).toBe(false);
        expect(await s.checkCliToken(secretOf(second))).toBe(false);
        expect(await s.checkCliToken("")).toBe(false);
    });
});

describe("CLI over HTTP", () => {
    it("manages the token from Settings", async () => {
        expect(await (await owner("/api/cli-token")).json()).toEqual({ exists: false });
        expect(await newToken()).toMatch(TOKEN);
        expect(await (await owner("/api/cli-token")).json()).toEqual({ exists: true });
        expect((await owner("/api/cli-token", { method: "DELETE" })).status).toBe(204);
        expect(await (await owner("/api/cli-token")).json()).toEqual({ exists: false });
    });

    it("answers every bad token with the same 401", async () => {
        const old = await newToken();
        const current = await newToken();
        const [doId] = current.split(".");
        const foreign = await env.USER_DO.getByName("cli-foreign").createCliToken();

        const bad = [
            null,
            "garbage",
            `${doId}.${"x".repeat(43)}`,
            `${foreign.split(".")[0]}.${secretOf(current)}`,
            `${"0".repeat(64)}.${secretOf(current)}`,
            old,
        ];
        const bodies = new Set<string>();
        for (const token of bad) {
            const res = await cli(token, "/tools");
            expect(res.status, String(token)).toBe(401);
            bodies.add(await res.text());
        }
        expect(bodies.size).toBe(1);

        const raw = await SELF.fetch("https://example.com/cli/tools", { headers: { authorization: current } });
        expect(raw.status).toBe(401);

        await owner("/api/cli-token", { method: "DELETE" });
        expect((await cli(current, "/tools")).status).toBe(401);
    });

    it("lists every tool but delete_event and show_tasks, with JSON Schema args", async () => {
        const token = await newToken();
        const res = await cli(token, "/tools");
        expect(res.status).toBe(200);
        const listed = (await res.json()) as { name: string; description: string; kind: string; args: { type: string } }[];

        const names = listed.map((t) => t.name);
        expect(names).not.toContain("delete_event");
        expect(names).not.toContain(SHOW_TASKS);
        expect(names).toEqual(tools.map((t) => t.name).filter((n) => n !== "delete_event" && n !== SHOW_TASKS));

        const add = listed.find((t) => t.name === "quick_add_task")!;
        expect(add.kind).toBe("write");
        expect(add.args).toMatchObject({ type: "object", required: ["text"] });
        expect(add.args).not.toHaveProperty("$schema");
    });

    it("refuses hidden and unknown tools with 404", async () => {
        const token = await newToken();
        for (const name of ["delete_event", SHOW_TASKS, "nope"]) {
            expect((await cli(token, `/tools/${name}`, {})).status, name).toBe(404);
        }
    });

    it("rejects bad args with the zod issues", async () => {
        const token = await newToken();
        const res = await cli(token, "/tools/complete_task", { id: 5 });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(/^id: /);
    });

    it("runs a write straight away and a read sees it", async () => {
        const token = await newToken();
        const added = await cli(token, "/tools/quick_add_task", { text: "Buy milk p1" });
        expect(added.status).toBe(200);
        expect(await added.json()).toMatchObject({ task: { content: "Buy milk", priority: 1 } });

        const overview = await cli(token, "/tools/get_overview", {});
        expect(overview.status).toBe(200);
        const { tasks } = (await overview.json()) as { tasks: { content: string; priority: number }[] };
        expect(tasks).toContainEqual(expect.objectContaining({ content: "Buy milk", priority: 1 }));

        const missing = await cli(token, "/tools/complete_task", { id: "nope" });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toHaveProperty("error");
    });
});
