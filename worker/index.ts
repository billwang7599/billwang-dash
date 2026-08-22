import { Hono, type Context } from "hono";
import type { z } from "zod";
import { getUser, type AuthedUser } from "./auth.ts";
import { UserDO } from "./user-do.ts";
import { buildAuthUrl } from "./google.ts";
import * as schemas from "./schemas.ts";
import * as service from "./service.ts";
import { ServiceError } from "./service.ts";

export { UserDO };

type Ctx = { Bindings: Env; Variables: { user: AuthedUser } };

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
  const { text, timeZone } = await body(c, schemas.quickAddBody);
  return c.json(await service.quickAddTask(stub(c), text, timeZone), 201);
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
  await stub(c).deleteTask(c.req.param("id"));
  return c.body(null, 204);
});

app.post("/api/projects", async (c) => {
  const { name, color } = await body(c, schemas.createProjectBody);
  return c.json({ project: await service.createProject(stub(c), name, color) }, 201);
});

app.patch("/api/projects/order", async (c) => {
  const { ids } = await body(c, schemas.reorderBody);
  await service.reorderProjects(stub(c), ids);
  return c.body(null, 204);
});

app.delete("/api/projects/:id", async (c) => {
  await service.deleteProject(stub(c), c.req.param("id"));
  return c.body(null, 204);
});

app.patch("/api/preferences", async (c) => {
  const s = stub(c);
  await s.setPreferences(await body(c, schemas.preferencesBody));
  return c.json({ preferences: await s.getPreferences() });
});

app.get("/api/calendar", async (c) =>
  c.json({
    items: await service.calendarItems(stub(c), c.req.query("start"), c.req.query("end")),
  }),
);

// ---- Google Calendar (read-only) -----------------------------------------

app.get("/api/google/status", async (c) => c.json(await stub(c).getGoogleStatus()));

app.get("/api/google/connect", async (c) =>
  c.redirect(buildAuthUrl(c.env, await service.beginGoogleAuth(stub(c), c.env))),
);

app.get("/api/google/callback", async (c) =>
  settings(c, await service.completeGoogleAuth(stub(c), c.env, c.req.query())),
);

app.post("/api/google/disconnect", async (c) => {
  const s = stub(c);
  await s.disconnectGoogle();
  return c.json(await s.getGoogleStatus());
});

app.patch("/api/google/calendars/:id", async (c) => {
  const { enabled } = await body(c, schemas.calendarToggleBody);
  const s = stub(c);
  await s.setCalendarEnabled(c.req.param("id"), enabled);
  return c.json(await s.getGoogleStatus());
});

app.use("/api/admin/*", async (c, next) => {
  if (!c.get("user").isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
});

app.get("/api/admin/whoami", (c) => c.json({ user: c.get("user"), admin: true }));

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
