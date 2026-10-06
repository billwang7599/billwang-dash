import { civilFromDate, civilFromKey, civilKey } from "../shared/civil.ts";
import type { Goal, GoalInput } from "../shared/goals.ts";
import type { DayStatus, HabitDetail, HabitInput, HabitSummary } from "../shared/habits.ts";
import { MAX_IMPORT_LINES, splitImportLines } from "../shared/import.ts";
import { parseQuickAdd } from "../shared/parser.ts";
import { exchangeCode } from "./google.ts";
import type { UserDO } from "./user-do.ts";
import type { AuthedUser } from "./auth.ts";
import type {
    CalEvent,
    CalendarItem,
    EventInput,
    GoogleAccountStatus,
    ParsedQuickAdd,
    Preferences,
    Project,
    Task,
    Trash,
} from "../shared/types.ts";

/** API logic, independent of HTTP. Takes a DO stub, not a Hono context. */

type Stub = DurableObjectStub<UserDO>;

/** index.ts maps this onto a response in app.onError. */
export class ServiceError extends Error {
    constructor(
        readonly status: 400 | 403 | 404 | 409 | 503,
        message: string,
    ) {
        super(message);
    }
}

export interface AppState {
    projects: Project[];
    tasks: Task[];
    preferences: Preferences;
    habits: HabitSummary[];
    goals: Goal[];
    user: AuthedUser;
}

/** One round trip for the initial app load. */
export async function loadState(
    stub: Stub,
    user: AuthedUser,
    includeCompleted: boolean,
): Promise<AppState> {
    const [projects, tasks, preferences, habits, goals] = await Promise.all([
        stub.listProjects(),
        stub.listTasks({ includeCompleted }),
        stub.getPreferences(),
        stub.listHabits(),
        stub.listGoals(),
        stub.syncProfile(user.email, user.name),
    ]);
    return { projects, tasks, preferences, habits, goals, user };
}

/** Re-parses server-side so what is stored cannot disagree with the preview. */
export async function quickAddTask(
    stub: Stub,
    text: string,
    timeZone: string | undefined,
): Promise<{ task: Task; parsed: ParsedQuickAdd }> {
    const prefs = await stub.getPreferences();
    const parsed = parseQuickAdd(text, {
        timeZone: timeZone ?? prefs.timeZone,
        dateFormat: prefs.dateFormat,
    });
    if (!parsed.content) throw new ServiceError(400, "task has no content");

    return { task: await stub.createTask(parsed), parsed };
}

export interface ImportResult {
    created: Task[];
    skipped: { line: string; reason: string }[];
}

/** One task per line. Lines that parse to no content are skipped, not fatal. */
export async function importTasks(
    stub: Stub,
    text: string,
    timeZone: string | undefined,
): Promise<ImportResult> {
    const lines = splitImportLines(text);
    if (lines.length === 0) throw new ServiceError(400, "nothing to import");
    if (lines.length > MAX_IMPORT_LINES) {
        throw new ServiceError(400, `at most ${MAX_IMPORT_LINES} tasks per import`);
    }

    const prefs = await stub.getPreferences();
    const options = { timeZone: timeZone ?? prefs.timeZone, dateFormat: prefs.dateFormat };

    const parsed: ParsedQuickAdd[] = [];
    const skipped: ImportResult["skipped"] = [];
    for (const line of lines) {
        const p = parseQuickAdd(line, options);
        if (p.content) parsed.push(p);
        else skipped.push({ line, reason: "no content" });
    }
    return { created: await stub.createTasks(parsed), skipped };
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
    if (patch.projectId && !(await stub.hasProject(patch.projectId))) {
        throw new ServiceError(400, "project not found");
    }
    const task = await stub.updateTask(id, patch);
    if (!task) throw new ServiceError(404, "not found");
    return task;
}

export async function deleteTask(stub: Stub, id: string): Promise<void> {
    await stub.deleteTask(id);
}

export async function createProject(
    stub: Stub,
    name: string,
    color: string | undefined,
): Promise<Project> {
    return stub.createProject(name, color);
}

export const getTrash = (stub: Stub): Promise<Trash> => stub.getTrash();

export async function restoreProject(stub: Stub, id: string): Promise<Project> {
    const result = await stub.restoreProject(id);
    if ("project" in result) return result.project;
    if (result.error === "name_taken") {
        throw new ServiceError(409, `A project named "${result.name}" already exists`);
    }
    throw new ServiceError(404, "not found");
}

export async function restoreTask(stub: Stub, id: string): Promise<Task> {
    const task = await stub.restoreTask(id);
    if (!task) throw new ServiceError(404, "not found");
    return task;
}

export const purgeProject = (stub: Stub, id: string): Promise<void> => stub.purgeProject(id);
export const purgeTask = (stub: Stub, id: string): Promise<void> => stub.purgeTask(id);
export const emptyTrash = (stub: Stub): Promise<void> => stub.emptyTrash();

// ---- Calendar events -------------------------------------------------------

export const createEvent = (stub: Stub, input: EventInput): Promise<CalEvent> =>
    stub.createEvent(input);

export async function updateEvent(stub: Stub, id: string, input: EventInput): Promise<CalEvent> {
    const event = await stub.updateEvent(id, input);
    if (!event) throw new ServiceError(404, "not found");
    return event;
}

export const deleteEvent = (stub: Stub, id: string): Promise<void> => stub.deleteEvent(id);

// ---- Habits ----------------------------------------------------------------

export const createHabit = (stub: Stub, input: HabitInput): Promise<HabitSummary> =>
    stub.createHabit(input);

export async function updateHabit(stub: Stub, id: string, input: HabitInput): Promise<HabitSummary> {
    const habit = await stub.updateHabit(id, input);
    if (!habit) throw new ServiceError(404, "not found");
    return habit;
}

export const deleteHabit = (stub: Stub, id: string): Promise<void> => stub.deleteHabit(id);

/** `month` is YYYY-MM; omitted means the current month in the user's zone. */
export async function getHabit(
    stub: Stub,
    id: string,
    month: string | undefined,
): Promise<HabitDetail> {
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new ServiceError(400, "month must look like 2026-08");
    }
    const resolved = month ?? (await todayKey(stub)).slice(0, 7);
    const detail = await stub.getHabitDetail(id, resolved);
    if (!detail) throw new ServiceError(404, "not found");
    return detail;
}

/** Past days are fine to log; the future is not. */
export async function setHabitCheckin(
    stub: Stub,
    id: string,
    day: string,
    status: DayStatus | null,
    note: string | undefined,
): Promise<HabitSummary> {
    if (!civilFromKey(day)) throw new ServiceError(400, "day must look like 2026-08-04");
    if (day > (await todayKey(stub))) throw new ServiceError(400, "can't check in a day that hasn't happened");
    const habit = await stub.setHabitCheckin(id, day, status, note);
    if (!habit) throw new ServiceError(404, "not found");
    return habit;
}

// ---- Goals -----------------------------------------------------------------

export const createGoal = (stub: Stub, input: GoalInput): Promise<Goal> => stub.createGoal(input);

export async function updateGoal(stub: Stub, id: string, input: GoalInput): Promise<Goal> {
    const goal = await stub.updateGoal(id, input);
    if (!goal) throw new ServiceError(404, "not found");
    return goal;
}

export async function setGoalProgress(stub: Stub, id: string, current: number): Promise<Goal> {
    const goal = await stub.setGoalProgress(id, current);
    if (!goal) throw new ServiceError(404, "not found");
    return goal;
}

export const deleteGoal = (stub: Stub, id: string): Promise<void> => stub.deleteGoal(id);

async function todayKey(stub: Stub): Promise<string> {
    const { timeZone } = await stub.getPreferences();
    return civilKey(civilFromDate(new Date(), timeZone));
}

export async function setProjectPinned(
    stub: Stub,
    id: string,
    pinned: boolean,
): Promise<Project> {
    const project = await stub.setProjectPinned(id, pinned);
    if (!project) throw new ServiceError(404, "not found");
    return project;
}

export async function setPreferences(
    stub: Stub,
    prefs: Partial<Preferences>,
): Promise<Preferences> {
    await stub.setPreferences(prefs);
    return stub.getPreferences();
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

export async function disconnectGoogle(stub: Stub): Promise<GoogleAccountStatus> {
    await stub.disconnectGoogle();
    return stub.getGoogleStatus();
}

export async function setCalendarEnabled(
    stub: Stub,
    id: string,
    enabled: boolean,
): Promise<GoogleAccountStatus> {
    await stub.setCalendarEnabled(id, enabled);
    return stub.getGoogleStatus();
}

/**
 * Turns pushing tasks to Google on or off. The checks live here, not in the DO, so
 * the user gets a clear 400 rather than an error thrown across the RPC boundary.
 */
export async function setGooglePush(
    stub: Stub,
    env: Env,
    enabled: boolean,
): Promise<GoogleAccountStatus> {
    if (!enabled) return stub.setGooglePush(false);

    if (!env.GOOGLE_CLIENT_ID) throw new ServiceError(503, "Google is not configured");
    const status = await stub.getGoogleStatus();
    if (!status.connected) throw new ServiceError(400, "Connect Google first");
    if (!status.canWrite) {
        throw new ServiceError(400, "Reconnect Google to grant access to the dash calendar");
    }
    try {
        return await stub.setGooglePush(true);
    } catch (err) {
        console.error("Could not enable Google push", err);
        throw new ServiceError(503, `Could not set up the dash calendar in Google: ${(err as Error).message}`);
    }
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
