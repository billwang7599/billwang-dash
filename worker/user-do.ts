import { DurableObject } from "cloudflare:workers";
import { addDays, civilFromDate, civilKey, weekday, zonedToUtcMs } from "../shared/civil.ts";
import type { Goal, GoalInput } from "../shared/goals.ts";
import type { DayStatus, HabitDay, HabitDetail, HabitInput, HabitSummary } from "../shared/habits.ts";
import * as eventStore from "./do/events.ts";
import * as goalStore from "./do/goals.ts";
import * as habitStore from "./do/habits.ts";
import { GoogleSync } from "./do/google.ts";
import { migrations } from "./do/migrations.ts";
import * as projectStore from "./do/projects.ts";
import * as taskStore from "./do/tasks.ts";
import type { TaskInput } from "./do/tasks.ts";
import * as trashStore from "./do/trash.ts";
import type { GoogleTokens } from "./google.ts";
import type {
    CalEvent,
    CalendarItem,
    EventInput,
    GoogleAccountStatus,
    Preferences,
    Project,
    Task,
    Trash,
} from "../shared/types.ts";

/**
 * All of one user's data, in one Durable Object — every query is a local
 * SQLite read, strongly consistent with its writes, no cross-user contention.
 * Addressed by getByName(user.id); see worker/auth.ts.
 */

export class UserDO extends DurableObject<Env> {
    private get sql() {
        return this.ctx.storage.sql;
    }

    private readonly google: GoogleSync;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.google = new GoogleSync(ctx.storage, env, () => this.getPreferences());
        ctx.blockConcurrencyWhile(async () => this.migrate());
    }

    private migrate() {
        const sql = this.sql;

        sql.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        const current = sql
            .exec<{ v: number }>("SELECT COALESCE(MAX(id), 0) AS v FROM _migrations")
            .one().v;

        for (const migration of migrations) {
            if (migration.version <= current) continue;
            sql.exec(migration.sql);
            migration.after?.(sql);
            sql.exec("INSERT INTO _migrations (id) VALUES (?)", migration.version);
        }
    }

    // ---- Profile -----------------------------------------------------------

    async syncProfile(email: string, name: string | null): Promise<void> {
        this.sql.exec("UPDATE profile SET email = ?, name = ? WHERE id = 1", email, name);
    }

    async setPreferences(prefs: Partial<Preferences>): Promise<void> {
        if (prefs.timeZone) {
            const before = (await this.getPreferences()).timeZone;
            this.sql.exec(
                "UPDATE profile SET time_zone = ?, time_zone_set = 1 WHERE id = 1",
                prefs.timeZone,
            );
            // Task times float with the zone, so Google's copies have to move too.
            if (prefs.timeZone !== before) await this.google.timeZoneChanged();
        }
        if (prefs.dateFormat) {
            this.sql.exec("UPDATE profile SET date_format = ? WHERE id = 1", prefs.dateFormat);
        }
        if (prefs.inboxHiddenProjects) {
            this.sql.exec(
                "UPDATE profile SET inbox_hidden_projects = ? WHERE id = 1",
                JSON.stringify([...new Set(prefs.inboxHiddenProjects)]),
            );
        }
        if (prefs.firstName !== undefined) {
            this.sql.exec("UPDATE profile SET first_name = ? WHERE id = 1", prefs.firstName);
        }
        if (prefs.lastName !== undefined) {
            this.sql.exec("UPDATE profile SET last_name = ? WHERE id = 1", prefs.lastName);
        }
        if (prefs.inboxHiddenGoals) {
            this.sql.exec(
                "UPDATE profile SET inbox_hidden_goals = ? WHERE id = 1",
                JSON.stringify([...new Set(prefs.inboxHiddenGoals)]),
            );
        }
    }

    async getPreferences(): Promise<Preferences> {
        const row = this.sql
            .exec<{
                time_zone: string;
                time_zone_set: number;
                date_format: string;
                inbox_hidden_projects: string;
                inbox_hidden_goals: string;
                first_name: string;
                last_name: string;
            }>(
                `SELECT time_zone, time_zone_set, date_format, inbox_hidden_projects, inbox_hidden_goals,
                        first_name, last_name
                 FROM profile WHERE id = 1`,
            )
            .one();
        return {
            timeZone: row.time_zone,
            timeZoneSet: row.time_zone_set === 1,
            dateFormat: row.date_format === "DMY" ? "DMY" : "MDY",
            inboxHiddenProjects: parseIdList(row.inbox_hidden_projects),
            inboxHiddenGoals: parseIdList(row.inbox_hidden_goals),
            firstName: row.first_name,
            lastName: row.last_name,
        };
    }

    // ---- Projects ----------------------------------------------------------

    async listProjects(): Promise<Project[]> {
        return projectStore.listProjects(this.sql);
    }

    async createProject(name: string, color = "slate"): Promise<Project> {
        return projectStore.createProject(this.sql, name, color);
    }

    async setProjectPinned(id: string, pinned: boolean): Promise<Project | null> {
        return projectStore.setProjectPinned(this.sql, id, pinned);
    }

    async setProjectColor(id: string, color: string): Promise<Project | null> {
        return projectStore.setProjectColor(this.sql, id, color);
    }

    /** False if the Inbox was targeted; it is the fallback for untagged tasks. */
    async deleteProject(id: string): Promise<boolean> {
        if (!projectStore.trashProject(this.sql, id)) return false;
        await this.google.markDirty(taskStore.taskIdsTrashedWith(this.sql, id));
        return true;
    }

    async hasProject(id: string): Promise<boolean> {
        return projectStore.hasProject(this.sql, id);
    }

    // ---- Tasks -------------------------------------------------------------

    async listTasks(options: { includeCompleted?: boolean } = {}): Promise<Task[]> {
        return taskStore.listTasks(this.sql, options);
    }

    async createTask(input: TaskInput): Promise<Task> {
        const task = taskStore.createTask(this.sql, input);
        await this.google.markDirty([task.id]);
        return task;
    }

    /** Bulk create. No real I/O between inserts, so they commit together. */
    async createTasks(inputs: TaskInput[]): Promise<Task[]> {
        const tasks: Task[] = [];
        for (const input of inputs) tasks.push(await this.createTask(input));
        return tasks;
    }

    async updateTask(id: string, patch: Partial<TaskInput>): Promise<Task | null> {
        const task = taskStore.updateTask(this.sql, id, patch);
        if (task) await this.google.markDirty([id]);
        return task;
    }

    async completeTask(id: string, todayKey: string): Promise<Task | null> {
        const task = taskStore.completeTask(this.sql, id, todayKey);
        if (task) await this.google.markDirty([id]);
        return task;
    }

    async listCompletedTasks(
        before: string | null,
        limit: number,
        projectId: string | null = null,
    ): Promise<{ tasks: Task[]; more: boolean }> {
        return taskStore.listCompleted(this.sql, before, limit, projectId);
    }

    /** Since Monday 00:00 in the user's zone. */
    async countCompletedThisWeek(): Promise<number> {
        return taskStore.countCompletedSince(this.sql, await this.weekStart());
    }

    /** The same, per project: project id -> count. */
    async countCompletedThisWeekByProject(): Promise<Record<string, number>> {
        return taskStore.countCompletedSinceByProject(this.sql, await this.weekStart());
    }

    /** Monday 00:00 in the user's zone, as an ISO instant. */
    private async weekStart(): Promise<string> {
        const { timeZone } = await this.getPreferences();
        const today = civilFromDate(new Date(), timeZone);
        const monday = addDays(today, -((weekday(today) + 6) % 7));
        return new Date(zonedToUtcMs(monday, 0, timeZone)).toISOString();
    }

    async uncompleteTask(id: string): Promise<Task | null> {
        const task = taskStore.uncompleteTask(this.sql, id);
        await this.google.markDirty([id]);
        return task;
    }

    async deleteTask(id: string): Promise<void> {
        taskStore.trashTask(this.sql, id);
        await this.google.markDirty([id]);
    }

    async getTask(id: string): Promise<Task | null> {
        return taskStore.getTask(this.sql, id);
    }

    // ---- Trash -------------------------------------------------------------

    async getTrash(): Promise<Trash> {
        return trashStore.getTrash(this.sql);
    }

    async restoreProject(
        id: string,
    ): Promise<{ project: Project } | { error: "not_found" } | { error: "name_taken"; name: string }> {
        // Read before the restore clears the tag.
        const restored = taskStore.taskIdsTrashedWith(this.sql, id);
        const result = trashStore.restoreProject(this.sql, id);
        if ("project" in result) await this.google.markDirty(restored);
        return result;
    }

    async restoreTask(id: string): Promise<Task | null> {
        const task = trashStore.restoreTask(this.sql, id);
        await this.google.markDirty([id]);
        return task;
    }

    async purgeProject(id: string): Promise<void> {
        trashStore.purgeProject(this.sql, id);
    }

    async purgeTask(id: string): Promise<void> {
        trashStore.purgeTask(this.sql, id);
    }

    async emptyTrash(): Promise<void> {
        trashStore.emptyTrash(this.sql);
    }

    // ---- Calendar events ---------------------------------------------------

    async createEvent(input: EventInput): Promise<CalEvent> {
        const event = eventStore.createEvent(this.sql, input);
        await this.google.markDirty([event.id]);
        return event;
    }

    async updateEvent(id: string, input: EventInput): Promise<CalEvent | null> {
        const event = eventStore.updateEvent(this.sql, id, input);
        await this.google.markDirty([id]);
        return event;
    }

    /** Permanent. The Google copy is removed by the next push. */
    async deleteEvent(id: string): Promise<void> {
        eventStore.deleteEvent(this.sql, id);
        await this.google.markDirty([id]);
    }

    // ---- Habits ------------------------------------------------------------

    /** Today's date in the user's zone, which is the day a check-in belongs to. */
    private todayKey(): string {
        const { time_zone } = this.sql
            .exec<{ time_zone: string }>("SELECT time_zone FROM profile WHERE id = 1")
            .one();
        return civilKey(civilFromDate(new Date(), time_zone));
    }

    async listHabits(): Promise<HabitSummary[]> {
        return habitStore.listHabits(this.sql, this.todayKey());
    }

    async createHabit(input: HabitInput): Promise<HabitSummary> {
        return habitStore.createHabit(this.sql, this.todayKey(), input);
    }

    async updateHabit(id: string, input: HabitInput): Promise<HabitSummary | null> {
        return habitStore.updateHabit(this.sql, this.todayKey(), id, input);
    }

    async deleteHabit(id: string): Promise<void> {
        habitStore.deleteHabit(this.sql, id);
    }

    async getMonthCheckins(month: string): Promise<Record<string, HabitDay[]>> {
        return habitStore.getMonthCheckins(this.sql, month);
    }

    async getHabitDetail(id: string, month: string): Promise<HabitDetail | null> {
        return habitStore.getHabitDetail(this.sql, this.todayKey(), id, month);
    }

    async setHabitCheckin(
        id: string,
        day: string,
        status: DayStatus | null,
        note: string | undefined,
    ): Promise<HabitSummary | null> {
        return habitStore.setHabitCheckin(this.sql, this.todayKey(), id, day, status, note);
    }

    // ---- Goals -------------------------------------------------------------

    async listGoals(): Promise<Goal[]> {
        return goalStore.listGoals(this.sql);
    }

    async createGoal(input: GoalInput): Promise<Goal> {
        return goalStore.createGoal(this.sql, input);
    }

    async updateGoal(id: string, input: GoalInput): Promise<Goal | null> {
        return goalStore.updateGoal(this.sql, id, input);
    }

    async hasGoal(id: string): Promise<boolean> {
        return goalStore.getGoal(this.sql, id) !== null;
    }

    async setGoalProgress(id: string, current: number): Promise<Goal | null> {
        return goalStore.setGoalProgress(this.sql, id, current);
    }

    async deleteGoal(id: string): Promise<void> {
        goalStore.deleteGoal(this.sql, id);
    }

    // ---- Google ------------------------------------------------------------

    beginGoogleAuth(): Promise<string> {
        return this.google.beginAuth();
    }

    consumeGoogleAuthState(state: string): Promise<boolean> {
        return this.google.consumeAuthState(state);
    }

    connectGoogle(tokens: GoogleTokens): Promise<GoogleAccountStatus> {
        return this.google.connect(tokens);
    }

    disconnectGoogle(): Promise<void> {
        return this.google.disconnect();
    }

    /** Manual sync: refetch Google events instead of trusting the cache. */
    syncGoogleNow(): Promise<GoogleAccountStatus> {
        return this.google.syncNow();
    }

    getGoogleStatus(): Promise<GoogleAccountStatus> {
        return this.google.status();
    }

    setCalendarEnabled(calendarId: string, enabled: boolean): Promise<void> {
        return this.google.setCalendarEnabled(calendarId, enabled);
    }

    /** Tasks, dash events and the user's Google events for a window. */
    async getCalendarItems(startISO: string, endISO: string): Promise<CalendarItem[]> {
        const { timeZone } = await this.getPreferences();
        return this.google.calendarItems(
            [
                ...taskStore.taskCalendarItems(this.sql, startISO, endISO, timeZone),
                ...eventStore.eventCalendarItems(this.sql, startISO, endISO, timeZone),
            ],
            startISO,
            endISO,
        );
    }

    /** Turns syncing on (creating the dash calendar the first time) or off. */
    setGooglePush(enabled: boolean): Promise<GoogleAccountStatus> {
        return this.google.setPush(enabled);
    }

    /** The platform calls this when the alarm the push queue set goes off. */
    alarm(): Promise<void> {
        return this.google.runPush();
    }
}

/** A stored JSON id list, repaired to [] if it is ever not one. */
function parseIdList(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}
