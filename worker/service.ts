import { civilFromDate, civilKey } from "../shared/civil.ts";
import { parseQuickAdd } from "../shared/parser.ts";
import { exchangeCode } from "./google.ts";
import type { UserDO } from "./user-do.ts";
import type { AuthedUser } from "./auth.ts";
import type {
  CalendarItem,
  ParsedQuickAdd,
  Preferences,
  Project,
  Task,
} from "../shared/types.ts";

/** API logic, independent of HTTP. Takes a DO stub, not a Hono context. */

type Stub = DurableObjectStub<UserDO>;

/** index.ts maps this onto a response in app.onError. */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface AppState {
  projects: Project[];
  tasks: Task[];
  preferences: Preferences;
  user: AuthedUser;
}

/** One round trip for the initial app load. */
export async function loadState(
  stub: Stub,
  user: AuthedUser,
  includeCompleted: boolean,
): Promise<AppState> {
  const [projects, tasks, preferences] = await Promise.all([
    stub.listProjects(),
    stub.listTasks({ includeCompleted }),
    stub.getPreferences(),
    stub.syncProfile(user.email, user.name),
  ]);
  return { projects, tasks, preferences, user };
}

/** Re-parses server-side so what is stored cannot disagree with the preview. */
export async function quickAddTask(
  stub: Stub,
  text: string | undefined,
  timeZone: string | undefined,
): Promise<{ task: Task; parsed: ParsedQuickAdd }> {
  if (!text?.trim()) throw new ServiceError(400, "text is required");

  const prefs = await stub.getPreferences();
  const parsed = parseQuickAdd(text.trim(), {
    timeZone: timeZone ?? prefs.timeZone,
    dateFormat: prefs.dateFormat,
  });
  if (!parsed.content) throw new ServiceError(400, "task has no content");

  return { task: await stub.createTask(parsed), parsed };
}

/** "Today" has to be resolved in the user's zone, not the Worker's. */
export async function completeTask(stub: Stub, id: string): Promise<Task> {
  const { timeZone } = await stub.getPreferences();
  const task = await stub.completeTask(id, civilKey(civilFromDate(new Date(), timeZone)));
  if (!task) throw new ServiceError(404, "not found");
  return task;
}

export async function uncompleteTask(stub: Stub, id: string): Promise<Task> {
  const task = await stub.uncompleteTask(id);
  if (!task) throw new ServiceError(404, "not found");
  return task;
}

export async function updateTask(
  stub: Stub,
  id: string,
  patch: Parameters<UserDO["updateTask"]>[1],
): Promise<Task> {
  const task = await stub.updateTask(id, patch);
  if (!task) throw new ServiceError(404, "not found");
  return task;
}

export async function createProject(
  stub: Stub,
  name: string | undefined,
  color: string | undefined,
): Promise<Project> {
  if (!name?.trim()) throw new ServiceError(400, "name is required");
  return stub.createProject(name.trim(), color);
}

export async function reorderProjects(stub: Stub, ids: unknown): Promise<void> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new ServiceError(400, "ids must be an array of project ids");
  }
  await stub.reorderProjects(ids);
}

export async function deleteProject(stub: Stub, id: string): Promise<void> {
  if (!(await stub.deleteProject(id))) {
    throw new ServiceError(400, "The Inbox cannot be deleted");
  }
}

export async function calendarItems(
  stub: Stub,
  start: string | undefined,
  end: string | undefined,
): Promise<CalendarItem[]> {
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    throw new ServiceError(400, "start and end must be ISO timestamps");
  }
  return stub.getCalendarItems(start, end);
}

export async function beginGoogleAuth(stub: Stub, env: Env): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID) throw new ServiceError(503, "Google is not configured");
  return stub.beginGoogleAuth();
}

/**
 * Returns a status word for the /app/settings query string rather than
 * throwing, since every outcome ends as a redirect. `state` is CSRF defence.
 */
export async function completeGoogleAuth(
  stub: Stub,
  env: Env,
  query: { code?: string; state?: string; error?: string },
): Promise<string> {
  if (query.error) return query.error;
  if (!query.code || !query.state) return "missing_code";
  if (!(await stub.consumeGoogleAuthState(query.state))) return "bad_state";

  try {
    await stub.connectGoogle(await exchangeCode(env, query.code));
    return "connected";
  } catch (err) {
    console.error("Google connect failed", err);
    return (err as Error).message;
  }
}
