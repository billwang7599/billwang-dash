import { DurableObject } from "cloudflare:workers";
import {
    civilFromKey,
    civilKey,
    parseTimeToMinutes,
    zonedToUtcMs,
} from "../shared/civil.ts";
import { nextOccurrence } from "../shared/parser.ts";
import {
    listCalendars,
    listEvents,
    refreshAccessToken,
    type GoogleTokens,
} from "./google.ts";
import type {
    CalendarItem,
    DueDate,
    GoogleAccountStatus,
    GoogleCalendarSummary,
    Preferences,
    Priority,
    Project,
    Recurrence,
    Task,
    Trash,
} from "../shared/types.ts";

/**
 * All of one user's data, in one Durable Object — every query is a local
 * SQLite read, strongly consistent with its writes, no cross-user contention.
 * Addressed by getByName(user.id); see worker/auth.ts.
 */

const INBOX_ID = "inbox";

interface TaskRow extends Record<string, SqlStorageValue> {
    id: string;
    content: string;
    description: string;
    project_id: string;
    priority: number;
    due_date: string | null;
    due_time: string | null;
    recurrence: string | null;
    deadline: string | null;
    duration_minutes: number | null;
    completed: number;
    completed_at: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    trashed_with: string | null;
}

interface ProjectRow extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    color: string;
    is_inbox: number;
    sort_order: number;
    created_at: string;
    pinned: number;
    deleted_at: string | null;
}

const toProject = (r: ProjectRow): Project => ({
    id: r.id,
    name: r.name,
    color: r.color,
    isInbox: r.is_inbox === 1,
    order: r.sort_order,
    createdAt: r.created_at,
    pinned: r.pinned === 1,
});

export interface TaskInput {
    content: string;
    description?: string;
    projectName?: string | null;
    projectId?: string | null;
    priority?: Priority;
    due?: DueDate | null;
    deadline?: string | null;
    durationMinutes?: number | null;
}

export class UserDO extends DurableObject<Env> {
    private get sql() {
        return this.ctx.storage.sql;
    }

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
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

        const version = sql
            .exec<{ v: number }>("SELECT COALESCE(MAX(id), 0) AS v FROM _migrations")
            .one().v;

        if (version < 1) {
            sql.exec(`
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL DEFAULT 'slate',
                    is_inbox INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    priority INTEGER NOT NULL DEFAULT 4,
                    due_date TEXT,
                    due_time TEXT,
                    due_tz TEXT,
                    recurrence TEXT,
                    deadline TEXT,
                    duration_minutes INTEGER,
                    completed INTEGER NOT NULL DEFAULT 0,
                    completed_at TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX idx_tasks_due ON tasks(completed, due_date);
                CREATE INDEX idx_tasks_project ON tasks(project_id, completed);

                CREATE TABLE task_labels (
                    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    label TEXT NOT NULL,
                    PRIMARY KEY (task_id, label)
                );

                CREATE TABLE profile (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    email TEXT,
                    name TEXT,
                    time_zone TEXT NOT NULL DEFAULT 'UTC',
                    date_format TEXT NOT NULL DEFAULT 'MDY'
                );

                INSERT INTO _migrations (id) VALUES (1);
            `);

            // Every user starts with an Inbox, matching Todoist's default target for
            // tasks created without a project.
            sql.exec(
                "INSERT INTO projects (id, name, color, is_inbox, sort_order) VALUES (?, ?, ?, 1, 0)",
                INBOX_ID,
                "Inbox",
                "slate",
            );
            sql.exec("INSERT INTO profile (id) VALUES (1)");
        }

        if (version < 2) {
            sql.exec(`
                CREATE TABLE google_account (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    email TEXT,
                    refresh_token TEXT NOT NULL,
                    access_token TEXT,
                    expires_at INTEGER NOT NULL DEFAULT 0,
                    connected_at TEXT NOT NULL,
                    last_synced_at TEXT
                );

                CREATE TABLE google_calendars (
                    id TEXT PRIMARY KEY,
                    summary TEXT NOT NULL,
                    color TEXT NOT NULL,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE oauth_state (
                    state TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL
                );

                INSERT INTO _migrations (id) VALUES (2);
            `);
        }

        if (version < 3) {
            // Dropped again in migration 6; nav is two fixed items now.
            sql.exec(`
                ALTER TABLE profile ADD COLUMN nav_order TEXT NOT NULL DEFAULT '';

                INSERT INTO _migrations (id) VALUES (3);
            `);
        }

        if (version < 4) {
            // '' means "created before this column existed" -- sorts as oldest,
            // the honest answer since the real creation time isn't known.
            sql.exec(`
                ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

                INSERT INTO _migrations (id) VALUES (4);
            `);
        }

        if (version < 5) {
            sql.exec(`
                ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

                INSERT INTO _migrations (id) VALUES (5);
            `);
        }

        if (version < 6) {
            sql.exec(`
                ALTER TABLE profile DROP COLUMN nav_order;

                INSERT INTO _migrations (id) VALUES (6);
            `);
        }

        if (version < 7) {
            // Due times are floating: read in the profile's zone, so a per-task zone
            // would only ever be stale.
            sql.exec(`
                ALTER TABLE tasks DROP COLUMN due_tz;

                INSERT INTO _migrations (id) VALUES (7);
            `);
        }

        if (version < 8) {
            sql.exec(`
                DROP TABLE task_labels;

                INSERT INTO _migrations (id) VALUES (8);
            `);
        }

        if (version < 9) {
            // Soft delete. trashed_with is the project whose deletion took a task to
            // the trash, so a restore knows which tasks went with it. NULL means the
            // task was trashed on its own.
            sql.exec(`
                ALTER TABLE projects ADD COLUMN deleted_at TEXT;
                ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
                ALTER TABLE tasks ADD COLUMN trashed_with TEXT;

                INSERT INTO _migrations (id) VALUES (9);
            `);
        }

        if (version < 10) {
            // Existing accounts that moved off the UTC default already chose a zone.
            sql.exec(`
                ALTER TABLE profile ADD COLUMN time_zone_set INTEGER NOT NULL DEFAULT 0;
                UPDATE profile SET time_zone_set = 1 WHERE time_zone != 'UTC';

                INSERT INTO _migrations (id) VALUES (10);
            `);
        }
    }

    // ---- Profile -----------------------------------------------------------

    async syncProfile(email: string, name: string | null): Promise<void> {
        this.sql.exec("UPDATE profile SET email = ?, name = ? WHERE id = 1", email, name);
    }

    async setPreferences(prefs: Partial<Preferences>): Promise<void> {
        if (prefs.timeZone) {
            this.sql.exec(
                "UPDATE profile SET time_zone = ?, time_zone_set = 1 WHERE id = 1",
                prefs.timeZone,
            );
        }
        if (prefs.dateFormat) {
            this.sql.exec("UPDATE profile SET date_format = ? WHERE id = 1", prefs.dateFormat);
        }
    }

    async getPreferences(): Promise<Preferences> {
        const row = this.sql
            .exec<{
                time_zone: string;
                time_zone_set: number;
                date_format: string;
            }>("SELECT time_zone, time_zone_set, date_format FROM profile WHERE id = 1")
            .one();
        return {
            timeZone: row.time_zone,
            timeZoneSet: row.time_zone_set === 1,
            dateFormat: row.date_format === "DMY" ? "DMY" : "MDY",
        };
    }

    // ---- Projects ----------------------------------------------------------

    async listProjects(): Promise<Project[]> {
        return this.sql
            .exec<ProjectRow>("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY is_inbox DESC, sort_order, name")
            .toArray()
            .map(toProject);
    }

    async createProject(name: string, color = "slate"): Promise<Project> {
        const existing = this.findProjectByName(name);
        if (existing) return existing;

        const id = crypto.randomUUID();
        const order = this.nextOrder("projects");
        const createdAt = new Date().toISOString();
        this.sql.exec(
            "INSERT INTO projects (id, name, color, is_inbox, sort_order, created_at) VALUES (?, ?, ?, 0, ?, ?)",
            id, name, color, order, createdAt,
        );
        return { id, name, color, isInbox: false, order, createdAt, pinned: false };
    }

    async setProjectPinned(id: string, pinned: boolean): Promise<Project | null> {
        this.sql.exec(
            "UPDATE projects SET pinned = ? WHERE id = ? AND deleted_at IS NULL",
            pinned ? 1 : 0, id,
        );
        const [row] = this.sql
            .exec<ProjectRow>("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", id)
            .toArray();
        return row ? toProject(row) : null;
    }

    /** False if the Inbox was targeted; it is the fallback for untagged tasks. */
    async deleteProject(id: string): Promise<boolean> {
        if (id === INBOX_ID) return false;
        const now = new Date().toISOString();
        // Tasks already in the trash were deleted on their own, so they are not
        // tagged and a restore of the project leaves them there.
        this.sql.exec(
            "UPDATE tasks SET deleted_at = ?, trashed_with = ? WHERE project_id = ? AND deleted_at IS NULL",
            now, id, id,
        );
        this.sql.exec(
            "UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            now, id,
        );
        return true;
    }

    async hasProject(id: string): Promise<boolean> {
        return (
            this.sql
                .exec("SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL", id)
                .toArray().length > 0
        );
    }

    private findProjectByName(name: string): Project | null {
        const [row] = this.sql
            .exec<ProjectRow>("SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1", name)
            .toArray();
        return row ? toProject(row) : null;
    }

    // ---- Tasks -------------------------------------------------------------

    async listTasks(options: { includeCompleted?: boolean } = {}): Promise<Task[]> {
        const where = options.includeCompleted
            ? "WHERE deleted_at IS NULL"
            : "WHERE deleted_at IS NULL AND completed = 0";
        const rows = this.sql
            .exec<TaskRow>(
                `SELECT * FROM tasks ${where}
               ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, priority, sort_order`,
            )
            .toArray();
        return this.hydrate(rows);
    }

    async createTask(input: TaskInput): Promise<Task> {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        // A "#project" that doesn't exist yet is created on the fly, as Todoist does.
        let projectId = input.projectId ?? null;
        if (!projectId && input.projectName) {
            projectId = (await this.createProject(input.projectName)).id;
        }
        projectId ??= INBOX_ID;

        const due = input.due ?? null;

        this.sql.exec(
            `INSERT INTO tasks (
               id, content, description, project_id, priority,
               due_date, due_time, recurrence, deadline, duration_minutes,
               completed, completed_at, sort_order, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
            id,
            input.content,
            input.description ?? "",
            projectId,
            input.priority ?? 4,
            due?.date ?? null,
            due?.time ?? null,
            due?.recurrence ? JSON.stringify(due.recurrence) : null,
            input.deadline ?? null,
            input.durationMinutes ?? null,
            this.nextOrder("tasks"),
            now,
            now,
        );

        return (await this.getTask(id))!;
    }

    /** Bulk create. No real I/O between inserts, so they commit together. */
    async createTasks(inputs: TaskInput[]): Promise<Task[]> {
        const tasks: Task[] = [];
        for (const input of inputs) tasks.push(await this.createTask(input));
        return tasks;
    }

    async updateTask(id: string, patch: Partial<TaskInput>): Promise<Task | null> {
        const existing = await this.getTask(id);
        if (!existing) return null;

        const sets: string[] = [];
        const values: unknown[] = [];
        const set = (col: string, value: unknown) => {
            sets.push(`${col} = ?`);
            values.push(value);
        };

        if (patch.content !== undefined) set("content", patch.content);
        if (patch.description !== undefined) set("description", patch.description);
        if (patch.priority !== undefined) set("priority", patch.priority);
        if (patch.deadline !== undefined) set("deadline", patch.deadline);
        if (patch.durationMinutes !== undefined) {
            set("duration_minutes", patch.durationMinutes);
        }
        if (patch.projectId !== undefined && patch.projectId) {
            set("project_id", patch.projectId);
        }
        if (patch.due !== undefined) {
            set("due_date", patch.due?.date ?? null);
            set("due_time", patch.due?.time ?? null);
            set("recurrence", patch.due?.recurrence ? JSON.stringify(patch.due.recurrence) : null);
        }

        if (sets.length > 0) {
            set("updated_at", new Date().toISOString());
            this.sql.exec(
                `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
                ...values,
                id,
            );
        }

        return this.getTask(id);
    }

    /**
     * Recurring tasks roll forward instead of closing. `every!` counts from the
     * completion date, everything else from the scheduled date — so a daily
     * habit finished three days late doesn't fire three times catching up.
     */
    async completeTask(id: string, todayKey: string): Promise<Task | null> {
        const task = await this.getTask(id);
        if (!task) return null;

        const recurrence = task.due?.recurrence ?? null;
        const now = new Date().toISOString();

        if (recurrence && task.due) {
            const scheduled = civilFromKey(task.due.date);
            const today = civilFromKey(todayKey) ?? scheduled;
            if (scheduled && today) {
                const from = recurrence.fromCompletion ? today : scheduled;
                const next = nextOccurrence(recurrence, from, scheduled);
                this.sql.exec(
                    "UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?",
                    civilKey(next), now, id,
                );
                return this.getTask(id);
            }
        }

        this.sql.exec(
            "UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?",
            now, now, id,
        );
        return this.getTask(id);
    }

    async uncompleteTask(id: string): Promise<Task | null> {
        this.sql.exec(
            "UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?",
            new Date().toISOString(), id,
        );
        return this.getTask(id);
    }

    async deleteTask(id: string): Promise<void> {
        this.sql.exec(
            "UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            new Date().toISOString(), id,
        );
    }

    async getTask(id: string): Promise<Task | null> {
        const rows = this.sql
            .exec<TaskRow>("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", id)
            .toArray();
        if (rows.length === 0) return null;
        return this.hydrate(rows)[0];
    }

    // ---- Trash -------------------------------------------------------------

    async getTrash(): Promise<Trash> {
        const projectRows = this.sql
            .exec<ProjectRow>(
                "SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
            )
            .toArray();
        const projects = projectRows.map((r) => ({
            ...toProject(r),
            deletedAt: r.deleted_at!,
            // Only the tasks that went with it; ones trashed earlier stay behind on restore.
            taskCount: this.sql
                .exec<{ n: number }>(
                    "SELECT COUNT(*) AS n FROM tasks WHERE trashed_with = ?",
                    r.id,
                )
                .one().n,
        }));

        // A task inside a trashed project is covered by that project's row.
        const taskRows = this.sql
            .exec<TaskRow>(
                `SELECT * FROM tasks
                 WHERE deleted_at IS NOT NULL
                   AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
                 ORDER BY deleted_at DESC`,
            )
            .toArray();
        const tasks = this.hydrate(taskRows).map((t, i) => ({
            ...t,
            deletedAt: taskRows[i].deleted_at!,
        }));

        return { projects, tasks };
    }

    /**
     * Brings back the project and the tasks that were trashed with it. Refused if
     * a live project now has the same name, so names stay unique.
     */
    async restoreProject(
        id: string,
    ): Promise<{ project: Project } | { error: "not_found" } | { error: "name_taken"; name: string }> {
        const [row] = this.sql
            .exec<ProjectRow>(
                "SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL",
                id,
            )
            .toArray();
        if (!row) return { error: "not_found" };
        if (this.findProjectByName(row.name)) return { error: "name_taken", name: row.name };

        this.sql.exec(
            "UPDATE tasks SET deleted_at = NULL, trashed_with = NULL WHERE trashed_with = ?",
            id,
        );
        this.sql.exec("UPDATE projects SET deleted_at = NULL WHERE id = ?", id);
        return { project: toProject({ ...row, deleted_at: null }) };
    }

    /** Null if the task isn't in the trash or its project still is. */
    async restoreTask(id: string): Promise<Task | null> {
        this.sql.exec(
            `UPDATE tasks SET deleted_at = NULL
             WHERE id = ? AND deleted_at IS NOT NULL
               AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
            id,
        );
        return this.getTask(id);
    }

    // Permanent deletes only touch rows already in the trash. Tasks go with their
    // project via ON DELETE CASCADE (foreign keys are on).

    async purgeProject(id: string): Promise<void> {
        this.sql.exec("DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL", id);
    }

    async purgeTask(id: string): Promise<void> {
        this.sql.exec("DELETE FROM tasks WHERE id = ? AND deleted_at IS NOT NULL", id);
    }

    async emptyTrash(): Promise<void> {
        this.sql.exec("DELETE FROM projects WHERE deleted_at IS NOT NULL");
        this.sql.exec("DELETE FROM tasks WHERE deleted_at IS NOT NULL");
    }

    // ---- Google Calendar (read-only) ---------------------------------------

    /** Single-use CSRF token, stored so the callback can consume it exactly once. */
    async beginGoogleAuth(): Promise<string> {
        const state = crypto.randomUUID();
        const cutoff = Date.now() - 10 * 60_000;
        this.sql.exec("DELETE FROM oauth_state WHERE created_at < ?", cutoff);
        this.sql.exec(
            "INSERT INTO oauth_state (state, created_at) VALUES (?, ?)",
            state, Date.now(),
        );
        return state;
    }

    async consumeGoogleAuthState(state: string): Promise<boolean> {
        const rows = this.sql
            .exec<{ state: string }>("SELECT state FROM oauth_state WHERE state = ?", state)
            .toArray();
        if (rows.length === 0) return false;
        this.sql.exec("DELETE FROM oauth_state WHERE state = ?", state);
        return true;
    }

    async connectGoogle(tokens: GoogleTokens): Promise<GoogleAccountStatus> {
        if (!tokens.refreshToken) {
            throw new Error(
                "Google did not return a refresh token. Revoke the app at " +
                    "myaccount.google.com/permissions and connect again.",
            );
        }

        this.sql.exec("DELETE FROM google_account");
        this.sql.exec(
            `INSERT INTO google_account
               (id, email, refresh_token, access_token, expires_at, connected_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
            tokens.email, tokens.refreshToken, tokens.accessToken, tokens.expiresAt,
            new Date().toISOString(),
        );

        await this.refreshCalendarList(tokens.accessToken);
        return this.getGoogleStatus();
    }

    async disconnectGoogle(): Promise<void> {
        this.sql.exec("DELETE FROM google_account");
        this.sql.exec("DELETE FROM google_calendars");
    }

    async getGoogleStatus(): Promise<GoogleAccountStatus> {
        const rows = this.sql
            .exec<{ email: string | null; connected_at: string; last_synced_at: string | null }>(
                "SELECT email, connected_at, last_synced_at FROM google_account WHERE id = 1",
            )
            .toArray();

        if (rows.length === 0) {
            return { connected: false, email: null, connectedAt: null, lastSyncedAt: null, calendars: [] };
        }

        return {
            connected: true,
            email: rows[0].email,
            connectedAt: rows[0].connected_at,
            lastSyncedAt: rows[0].last_synced_at,
            calendars: this.storedCalendars(),
        };
    }

    async setCalendarEnabled(calendarId: string, enabled: boolean): Promise<void> {
        this.sql.exec(
            "UPDATE google_calendars SET enabled = ? WHERE id = ?",
            enabled ? 1 : 0, calendarId,
        );
    }

    /**
     * Tasks and Google events for a window. Events are fetched live, not cached —
     * a stale calendar is worse than an extra API call at this volume.
     */
    async getCalendarItems(startISO: string, endISO: string): Promise<CalendarItem[]> {
        const { timeZone } = await this.getPreferences();
        const items = this.taskCalendarItems(startISO, endISO, timeZone);

        const accessToken = await this.getValidAccessToken();
        if (!accessToken) return items;

        const enabled = this.storedCalendars().filter((c) => c.enabled);
        if (enabled.length === 0) return items;

        // One bad calendar shouldn't blank the whole view.
        const results = await Promise.allSettled(
            enabled.map((cal) => listEvents(accessToken, cal.id, startISO, endISO)),
        );

        results.forEach((result, i) => {
            if (result.status !== "fulfilled") return;
            const cal = enabled[i];
            for (const event of result.value) {
                items.push({
                    id: `gcal:${cal.id}:${event.id}`,
                    kind: "gcal",
                    title: event.summary,
                    start: event.start,
                    end: event.end,
                    allDay: event.allDay,
                    calendarId: cal.id,
                    color: cal.color,
                    htmlLink: event.htmlLink,
                    location: event.location,
                });
            }
        });

        this.sql.exec(
            "UPDATE google_account SET last_synced_at = ? WHERE id = 1",
            new Date().toISOString(),
        );

        return items.sort((a, b) => a.start.localeCompare(b.start));
    }

    /** Scheduled tasks in the window, projected onto the timeline. */
    private taskCalendarItems(
        startISO: string,
        endISO: string,
        timeZone: string,
    ): CalendarItem[] {
        const startMs = Date.parse(startISO);
        const endMs = Date.parse(endISO);

        const rows = this.sql
            .exec<TaskRow>(
                "SELECT * FROM tasks WHERE deleted_at IS NULL AND completed = 0 AND due_date IS NOT NULL AND due_date BETWEEN ? AND ?",
                startISO.slice(0, 10),
                endISO.slice(0, 10),
            )
            .toArray();

        const items: CalendarItem[] = [];
        for (const task of this.hydrate(rows)) {
            if (!task.due) continue;
            const civil = civilFromKey(task.due.date);
            if (!civil) continue;

            const allDay = task.due.time === null;
            const startMinutes = allDay ? 0 : parseTimeToMinutes(task.due.time!);
            const taskStart = zonedToUtcMs(civil, startMinutes, timeZone);
            const taskEnd = allDay
                ? zonedToUtcMs(civil, 24 * 60, timeZone)
                : taskStart + (task.durationMinutes ?? 30) * 60_000;

            if (taskEnd < startMs || taskStart > endMs) continue;

            items.push({
                id: `task:${task.id}`,
                kind: "task",
                title: task.content,
                start: new Date(taskStart).toISOString(),
                end: new Date(taskEnd).toISOString(),
                allDay,
                priority: task.priority,
                completed: task.completed,
                projectId: task.projectId,
            });
        }
        return items;
    }

    private storedCalendars(): GoogleCalendarSummary[] {
        return this.sql
            .exec<{
                id: string; summary: string; color: string;
                is_primary: number; enabled: number;
            }>("SELECT * FROM google_calendars ORDER BY is_primary DESC, summary")
            .toArray()
            .map((c) => ({
                id: c.id,
                summary: c.summary,
                color: c.color,
                primary: c.is_primary === 1,
                enabled: c.enabled === 1,
            }));
    }

    private async refreshCalendarList(accessToken: string): Promise<void> {
        const calendars = await listCalendars(accessToken);
        // Preserve which calendars the user switched off across a re-sync.
        const disabled = new Set(
            this.storedCalendars().filter((c) => !c.enabled).map((c) => c.id),
        );

        this.sql.exec("DELETE FROM google_calendars");
        for (const cal of calendars) {
            this.sql.exec(
                `INSERT INTO google_calendars (id, summary, color, is_primary, enabled)
               VALUES (?, ?, ?, ?, ?)`,
                cal.id, cal.summary, cal.color,
                cal.primary ? 1 : 0,
                disabled.has(cal.id) ? 0 : 1,
            );
        }
    }

    /** Shared in-flight refresh: a fetch lets requests interleave, so a burst
     * of calendar loads on an expired token would otherwise each refresh. */
    private refreshing: Promise<string | null> | null = null;

    private async getValidAccessToken(): Promise<string | null> {
        const rows = this.sql
            .exec<{ refresh_token: string; access_token: string | null; expires_at: number }>(
                "SELECT refresh_token, access_token, expires_at FROM google_account WHERE id = 1",
            )
            .toArray();
        if (rows.length === 0) return null;

        const row = rows[0];
        if (row.access_token && row.expires_at > Date.now() + 60_000) {
            return row.access_token;
        }

        this.refreshing ??= this.doRefresh(row.refresh_token).finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    private async doRefresh(refreshToken: string): Promise<string | null> {
        try {
            const tokens = await refreshAccessToken(this.env, refreshToken);
            this.sql.exec(
                "UPDATE google_account SET access_token = ?, expires_at = ? WHERE id = 1",
                tokens.accessToken, tokens.expiresAt,
            );
            return tokens.accessToken;
        } catch (err) {
            // A revoked grant should read as "not connected", not 500 the calendar.
            console.error("Google token refresh failed", err);
            return null;
        }
    }

    // ---- Helpers -----------------------------------------------------------

    private hydrate(rows: TaskRow[]): Task[] {
        return rows.map((r) => ({
            id: r.id,
            content: r.content,
            description: r.description,
            projectId: r.project_id,
            priority: r.priority as Priority,
            due: r.due_date
                ? {
                        date: r.due_date,
                        time: r.due_time,
                        recurrence: r.recurrence
                            ? (JSON.parse(r.recurrence) as Recurrence)
                            : null,
                    }
                : null,
            deadline: r.deadline,
            durationMinutes: r.duration_minutes,
            completed: r.completed === 1,
            completedAt: r.completed_at,
            order: r.sort_order,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }

    private nextOrder(table: "tasks" | "projects"): number {
        return (
            this.sql
                .exec<{ next: number }>(
                    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ${table}`,
                )
                .one().next
        );
    }
}
