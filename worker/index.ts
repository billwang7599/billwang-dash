import { Hono, type Context } from "hono";
import type { z } from "zod";
import { runAgent, type Model } from "./ai/agent.ts";
import { argsSchema, CLI_EXCLUDED, type Stub, tools } from "./ai/tools.ts";
import { getUser, type AuthedUser } from "./auth.ts";
import type { ShareInfo } from "../shared/share.ts";
import { UserDO } from "./user-do.ts";
import { buildAuthUrl } from "./google.ts";
import * as schemas from "./schemas.ts";
import * as service from "./service.ts";
import { ServiceError } from "./service.ts";

export { UserDO };

type Ctx = { Bindings: Env; Variables: { user: AuthedUser; cliStub: Stub } };

const app = new Hono<Ctx>();

const stub = (c: Context<Ctx>) => c.env.USER_DO.getByName(c.get("user").id);
const settings = (c: Context<Ctx>, msg: string) =>
    c.redirect(`/app/settings?google=${encodeURIComponent(msg)}`);

/**
 * The only way a request body should reach the service layer or the DO. Both a
 * malformed payload and a schema failure surface as 400s via app.onError.
 */
async function body<T>(c: Context<Ctx>, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown;
    try {
        raw = await c.req.json();
    } catch {
        throw new ServiceError(400, "expected a JSON body");
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
            .join("; ");
        throw new ServiceError(400, detail);
    }
    return parsed.data;
}

app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status);
    console.error("unhandled", err);
    return c.json({ error: "internal error" }, 500);
});

// ---- API -----------------------------------------------------------------

app.use("/api/*", async (c, next) => {
    const user = await getUser(c.req.raw, c.env);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
});

app.get("/api/me", (c) => c.json({ user: c.get("user") }));

app.get("/api/state", async (c) =>
    c.json(await service.loadState(stub(c), c.get("user"), c.req.query("completed") === "1")),
);

app.post("/api/tasks", async (c) => {
    const { text, timeZone, goalId, projectId } = await body(c, schemas.quickAddBody);
    return c.json(await service.quickAddTask(stub(c), text, timeZone, goalId, projectId), 201);
});

app.get("/api/tasks/completed", async (c) =>
    c.json(await service.listCompletedTasks(stub(c), c.req.query("before"), c.req.query("project"))),
);

app.post("/api/tasks/import", async (c) => {
    const { text, timeZone, projectId } = await body(c, schemas.importBody);
    return c.json(await service.importTasks(stub(c), text, timeZone, projectId), 201);
});

app.patch("/api/tasks/:id", async (c) =>
    c.json({
        task: await service.updateTask(
            stub(c),
            c.req.param("id"),
            await body(c, schemas.taskPatchBody),
        ),
    }),
);

app.post("/api/tasks/:id/complete", async (c) =>
    c.json({ task: await service.completeTask(stub(c), c.req.param("id")) }),
);

app.post("/api/tasks/:id/uncomplete", async (c) =>
    c.json({ task: await service.uncompleteTask(stub(c), c.req.param("id")) }),
);

app.delete("/api/tasks/:id", async (c) => {
    await service.deleteTask(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.get("/api/trash", async (c) => c.json(await service.getTrash(stub(c))));

app.post("/api/trash/projects/:id/restore", async (c) =>
    c.json({ project: await service.restoreProject(stub(c), c.req.param("id")) }),
);

app.post("/api/trash/tasks/:id/restore", async (c) =>
    c.json({ task: await service.restoreTask(stub(c), c.req.param("id")) }),
);

app.delete("/api/trash/projects/:id", async (c) => {
    await service.purgeProject(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.delete("/api/trash/tasks/:id", async (c) => {
    await service.purgeTask(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.delete("/api/trash", async (c) => {
    await service.emptyTrash(stub(c));
    return c.body(null, 204);
});

app.post("/api/events", async (c) => {
    const input = await body(c, schemas.eventBody);
    return c.json({ event: await service.createEvent(stub(c), input) }, 201);
});

app.patch("/api/events/:id", async (c) => {
    const input = await body(c, schemas.eventBody);
    return c.json({ event: await service.updateEvent(stub(c), c.req.param("id"), input) });
});

app.delete("/api/events/:id", async (c) => {
    await service.deleteEvent(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.post("/api/habits", async (c) => {
    const input = await body(c, schemas.habitBody);
    return c.json({ habit: await service.createHabit(stub(c), input) }, 201);
});

app.get("/api/habits", async (c) => c.json(await service.getHabitsMonth(stub(c), c.req.query("month"))));

app.get("/api/habits/:id", async (c) =>
    c.json(await service.getHabit(stub(c), c.req.param("id"), c.req.query("month"))),
);

app.patch("/api/habits/:id", async (c) => {
    const input = await body(c, schemas.habitBody);
    return c.json({ habit: await service.updateHabit(stub(c), c.req.param("id"), input) });
});

app.delete("/api/habits/:id", async (c) => {
    await service.deleteHabit(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.put("/api/habits/:id/checkins/:day", async (c) => {
    const { status, note } = await body(c, schemas.habitCheckinBody);
    return c.json({
        habit: await service.setHabitCheckin(stub(c), c.req.param("id"), c.req.param("day"), status, note),
    });
});

app.post("/api/goals", async (c) => {
    const input = await body(c, schemas.goalBody);
    return c.json({ goal: await service.createGoal(stub(c), input) }, 201);
});

app.patch("/api/goals/:id", async (c) => {
    const input = await body(c, schemas.goalBody);
    return c.json({ goal: await service.updateGoal(stub(c), c.req.param("id"), input) });
});

app.put("/api/goals/:id/progress", async (c) => {
    const { current } = await body(c, schemas.goalProgressBody);
    return c.json({ goal: await service.setGoalProgress(stub(c), c.req.param("id"), current) });
});

app.delete("/api/goals/:id", async (c) => {
    await service.deleteGoal(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.post("/api/projects", async (c) => {
    const { name, color } = await body(c, schemas.createProjectBody);
    return c.json({ project: await service.createProject(stub(c), name, color) }, 201);
});

app.delete("/api/projects/:id", async (c) => {
    await service.deleteProject(stub(c), c.req.param("id"));
    return c.body(null, 204);
});

app.patch("/api/projects/:id/pinned", async (c) => {
    const { pinned } = await body(c, schemas.pinnedBody);
    return c.json({ project: await service.setProjectPinned(stub(c), c.req.param("id"), pinned) });
});

app.patch("/api/projects/:id/color", async (c) => {
    const { color } = await body(c, schemas.projectColorBody);
    return c.json({ project: await service.setProjectColor(stub(c), c.req.param("id"), color) });
});

// ---- Share links (owner) --------------------------------------------------

/** The link is `/s/<DO id>.<token>`: the id routes a visitor to this user's DO without exposing their identity. */
function shareResponse(c: Context<Ctx>, info: ShareInfo | null) {
    if (!info) throw new ServiceError(404, "project not found");
    const doId = c.env.USER_DO.idFromName(c.get("user").id).toString();
    const url = info.token ? `${new URL(c.env.APP_ORIGIN).origin}/s/${doId}.${info.token}` : null;
    return c.json({ share: { enabled: info.enabled, url, limit: info.limit, usedToday: info.usedToday } });
}

app.get("/api/projects/:id/share", async (c) => shareResponse(c, await stub(c).getShare(c.req.param("id"))));

app.put("/api/projects/:id/share", async (c) => shareResponse(c, await stub(c).enableShare(c.req.param("id"))));

app.post("/api/projects/:id/share/rotate", async (c) =>
    shareResponse(c, await stub(c).rotateShare(c.req.param("id"))),
);

app.delete("/api/projects/:id/share", async (c) => shareResponse(c, await stub(c).disableShare(c.req.param("id"))));

app.patch("/api/projects/:id/share", async (c) => {
    const { limit } = await body(c, schemas.shareLimitBody);
    return shareResponse(c, await stub(c).setShareLimit(c.req.param("id"), limit));
});

app.get("/api/cli-token", async (c) => c.json({ exists: await stub(c).hasCliToken() }));

app.post("/api/cli-token", async (c) => c.json({ token: await stub(c).createCliToken() }, 201));

app.delete("/api/cli-token", async (c) => {
    await stub(c).revokeCliToken();
    return c.body(null, 204);
});

app.patch("/api/preferences", async (c) =>
    c.json({
        preferences: await service.setPreferences(
            stub(c),
            await body(c, schemas.preferencesBody),
        ),
    }),
);

app.get("/api/calendar", async (c) =>
    c.json(await service.calendarItems(stub(c), c.req.query("start"), c.req.query("end"))),
);

app.get("/api/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    return c.json(q ? await stub(c).search(q) : { tasks: [], events: [], habits: [] });
});

// ---- Assistant -----------------------------------------------------------

// The binding's run() is overloaded per model; runAgent only needs the chat shape.
const workersAi = (ai: Ai): Model => ({ run: (model, input) => ai.run(model as keyof AiModels, input as never) });

app.use("/api/ai/*", async (c, next) => {
    if (!c.get("user").isAdmin) return c.json({ error: "forbidden" }, 403);
    await next();
});

app.post("/api/ai/chat", async (c) => {
    const { messages, timeZone, approvals } = await body(c, schemas.chatBody);
    return c.json(await runAgent({ model: workersAi(c.env.AI), stub: stub(c), timeZone, messages, approvals }));
});

// ---- Google Calendar -----------------------------------------------------

app.get("/api/google/status", async (c) => c.json(await stub(c).getGoogleStatus()));

app.get("/api/google/connect", async (c) =>
    c.redirect(buildAuthUrl(c.env, await service.beginGoogleAuth(stub(c), c.env))),
);

app.get("/api/google/callback", async (c) =>
    settings(c, await service.completeGoogleAuth(stub(c), c.env, c.req.query())),
);

app.post("/api/google/disconnect", async (c) =>
    c.json(await service.disconnectGoogle(stub(c))),
);

app.post("/api/google/sync", async (c) => c.json(await service.syncGoogleNow(stub(c))));

app.post("/api/google/push", async (c) => {
    const { enabled } = await body(c, schemas.googlePushBody);
    return c.json(await service.setGooglePush(stub(c), c.env, enabled));
});

app.patch("/api/google/calendars/:id", async (c) => {
    const { enabled } = await body(c, schemas.calendarToggleBody);
    return c.json(await service.setCalendarEnabled(stub(c), c.req.param("id"), enabled));
});

app.use("/api/admin/*", async (c, next) => {
    if (!c.get("user").isAdmin) return c.json({ error: "forbidden" }, 403);
    await next();
});

app.get("/api/admin/whoami", (c) => c.json({ user: c.get("user"), admin: true }));

// ---- Share links (visitors) -----------------------------------------------

// No sign-in here: the token in the URL is the credential, and it only reaches the one
// project it belongs to. Access covers /app* and /api* only, so none of this is behind it.
// The URL is a secret, so it must not travel in a Referer (the page loads Google Fonts) or sit in a cache.
app.use("/s/*", async (c, next) => {
    await next();
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex");
});

/** `<DO id>.<secret>` (a share link or CLI token) to the owner's stub and the secret; null when malformed. */
function refStub(c: Context<Ctx>, ref: string) {
    const match = /^([0-9a-f]{64})\.([\w-]{1,64})$/.exec(ref);
    if (!match) return null;
    try {
        return { stub: c.env.USER_DO.get(c.env.USER_DO.idFromString(match[1])), secret: match[2] };
    } catch {
        return null;
    }
}

const sharedStub = (c: Context<Ctx>) => refStub(c, c.req.param("ref") ?? "");

const gone = new ServiceError(404, "This link is no longer active");

app.get("/s/:ref", (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/s/index.html";
    return c.env.ASSETS.fetch(new Request(url));
});

app.get("/s/:ref/data", async (c) => {
    const shared = sharedStub(c);
    const view = shared && (await shared.stub.sharedView(shared.secret));
    if (!view) throw gone;
    return c.json(view);
});

app.post("/s/:ref/tasks", async (c) => {
    const shared = sharedStub(c);
    if (!shared) throw gone;
    const { text } = await body(c, schemas.sharedTaskBody);
    const task = await shared.stub.addShared(shared.secret, text);
    if (!task) throw gone;
    if (task === "limit") throw new ServiceError(429, "Daily limit reached. Try again tomorrow.");
    return c.json({ task: { id: task.id, content: task.content, viaLink: true, completed: false } }, 201);
});

app.post("/s/:ref/tasks/:id/complete", async (c) => {
    const shared = sharedStub(c);
    if (!shared) throw gone;
    if (!(await shared.stub.completeShared(shared.secret, c.req.param("id")))) throw gone;
    return c.body(null, 204);
});

// ---- CLI -------------------------------------------------------------------

// Outside Access like /s/*: the bearer token is the credential. Every failure looks the same.
app.use("/cli/*", async (c, next) => {
    const ref = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const target = ref ? refStub(c, ref) : null;
    if (!target || !(await target.stub.checkCliToken(target.secret))) return c.json({ error: "unauthorized" }, 401);
    c.set("cliStub", target.stub);
    await next();
});

const cliTools = tools.filter((t) => !CLI_EXCLUDED.has(t.name));

app.get("/cli/tools", (c) =>
    c.json(cliTools.map((t) => ({ name: t.name, description: t.description, kind: t.kind, args: argsSchema(t) }))),
);

// Writes run straight away: holding the token is the approval the in-app chat asks for.
app.post("/cli/tools/:name", async (c) => {
    const tool = cliTools.find((t) => t.name === c.req.param("name"));
    if (!tool) throw new ServiceError(404, `no tool named ${c.req.param("name")}`);
    const args = await body(c, tool.args);
    const owner = c.get("cliStub");
    const { timeZone } = await owner.getPreferences();
    return c.json((await tool.run({ stub: owner, timeZone }, args)) ?? "done");
});

// ---- Documents -----------------------------------------------------------

async function serveApp(c: Context<Ctx>) {
    if (!(await getUser(c.req.raw, c.env))) {
        return c.text("Sign-in required: Access is not covering this path.", 401);
    }
    const url = new URL(c.req.url);
    url.pathname = "/app/index.html";
    return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
}

// Bare "/app" would otherwise hit the assets binding's directory redirect.
app.get("/app", serveApp);
app.get("/app/*", serveApp);

app.get("/logout", (c) =>
    c.env.ACCESS_TEAM_DOMAIN?.trim()
        ? c.redirect("/cdn-cgi/access/logout")
        : c.text("No Access session to clear (dev mode).", 200),
);

// A signed-in visitor arriving at "/" carries only the cookie, not the header.
app.get("/", async (c, next) => {
    const headers = c.req.raw.headers;
    const signedIn =
        headers.has("cf-access-jwt-assertion") ||
        /(?:^|;\s*)CF_Authorization=/.test(headers.get("cookie") ?? "");
    if (signedIn && (await getUser(c.req.raw, c.env))) return c.redirect("/app");
    await next();
});

// Public: landing page and its static assets.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
