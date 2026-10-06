import { civilFromKey, civilKey, parseTimeToMinutes, zonedToUtcMs } from "../../shared/civil.ts";
import { nextOccurrence } from "../../shared/parser.ts";
import type { CalendarItem, DueDate, Priority, Recurrence, Task } from "../../shared/types.ts";
import { INBOX_ID, nextOrder } from "./common.ts";
import { createProject } from "./projects.ts";

/**
 * Task storage. Plain functions over the DO's SQL handle; UserDO keeps the RPC
 * methods, delegates here, and tells the Google push queue what changed.
 */

export interface TaskRow extends Record<string, SqlStorageValue> {
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
    goal_id: string | null;
    completed: number;
    completed_at: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    trashed_with: string | null;
}

export interface TaskInput {
    content: string;
    description?: string;
    projectName?: string | null;
    projectId?: string | null;
    priority?: Priority;
    due?: DueDate | null;
    deadline?: string | null;
    durationMinutes?: number | null;
    goalId?: string | null;
}

export function toTasks(rows: TaskRow[]): Task[] {
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
        goalId: r.goal_id,
        completed: r.completed === 1,
        completedAt: r.completed_at,
        order: r.sort_order,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    }));
}

export function listTasks(sql: SqlStorage, options: { includeCompleted?: boolean } = {}): Task[] {
    const where = options.includeCompleted
        ? "WHERE deleted_at IS NULL"
        : "WHERE deleted_at IS NULL AND completed = 0";
    const rows = sql
        .exec<TaskRow>(
            `SELECT * FROM tasks ${where}
           ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, priority, sort_order`,
        )
        .toArray();
    return toTasks(rows);
}

/**
 * Completed tasks, most recent first, a page at a time. `before` is the
 * completedAt of the last task already shown; `more` says whether a next page exists.
 */
export function listCompleted(
    sql: SqlStorage,
    before: string | null,
    limit: number,
    /** Only this project's tasks, when given. */
    projectId: string | null = null,
): { tasks: Task[]; more: boolean } {
    const rows = sql
        .exec<TaskRow>(
            `SELECT * FROM tasks
             WHERE completed = 1 AND deleted_at IS NULL AND (? IS NULL OR completed_at < ?)
               AND (? IS NULL OR project_id = ?)
             ORDER BY completed_at DESC LIMIT ?`,
            before, before, projectId, projectId, limit + 1,
        )
        .toArray();
    return { tasks: toTasks(rows.slice(0, limit)), more: rows.length > limit };
}

/** Tasks completed at or after an instant (ISO), e.g. since the start of this week. */
export function countCompletedSince(sql: SqlStorage, since: string): number {
    return sql
        .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM tasks WHERE completed = 1 AND deleted_at IS NULL AND completed_at >= ?",
            since,
        )
        .one().n;
}

/** Like countCompletedSince, split by project: project id -> count. Projects with none are left out. */
export function countCompletedSinceByProject(sql: SqlStorage, since: string): Record<string, number> {
    const rows = sql
        .exec<{ project_id: string; n: number }>(
            `SELECT project_id, COUNT(*) AS n FROM tasks
             WHERE completed = 1 AND deleted_at IS NULL AND completed_at >= ?
             GROUP BY project_id`,
            since,
        )
        .toArray();
    return Object.fromEntries(rows.map((r) => [r.project_id, r.n]));
}

export function getTask(sql: SqlStorage, id: string): Task | null {
    const rows = sql
        .exec<TaskRow>("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", id)
        .toArray();
    return rows.length === 0 ? null : toTasks(rows)[0];
}

export function createTask(sql: SqlStorage, input: TaskInput): Task {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // A "#project" that doesn't exist yet is created on the fly, as Todoist does.
    let projectId = input.projectId ?? null;
    if (!projectId && input.projectName) {
        projectId = createProject(sql, input.projectName).id;
    }
    projectId ??= INBOX_ID;

    const due = input.due ?? null;

    sql.exec(
        `INSERT INTO tasks (
           id, content, description, project_id, priority,
           due_date, due_time, recurrence, deadline, duration_minutes, goal_id,
           completed, completed_at, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
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
        input.goalId ?? null,
        nextOrder(sql, "tasks"),
        now,
        now,
    );
    return getTask(sql, id)!;
}

export function updateTask(sql: SqlStorage, id: string, patch: Partial<TaskInput>): Task | null {
    if (!getTask(sql, id)) return null;

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
    if (patch.goalId !== undefined) set("goal_id", patch.goalId);
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
        sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
    }
    return getTask(sql, id);
}

/**
 * Recurring tasks roll forward instead of closing. `every!` counts from the
 * completion date, everything else from the scheduled date — so a daily
 * habit finished three days late doesn't fire three times catching up.
 */
export function completeTask(sql: SqlStorage, id: string, todayKey: string): Task | null {
    const task = getTask(sql, id);
    if (!task) return null;

    const recurrence = task.due?.recurrence ?? null;
    const now = new Date().toISOString();

    if (recurrence && task.due) {
        const scheduled = civilFromKey(task.due.date);
        const today = civilFromKey(todayKey) ?? scheduled;
        if (scheduled && today) {
            const from = recurrence.fromCompletion ? today : scheduled;
            const next = nextOccurrence(recurrence, from, scheduled);
            sql.exec(
                "UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?",
                civilKey(next), now, id,
            );
            return getTask(sql, id);
        }
    }

    sql.exec(
        "UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?",
        now, now, id,
    );
    return getTask(sql, id);
}

export function uncompleteTask(sql: SqlStorage, id: string): Task | null {
    sql.exec(
        "UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?",
        new Date().toISOString(), id,
    );
    return getTask(sql, id);
}

export function trashTask(sql: SqlStorage, id: string): void {
    sql.exec(
        "UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        new Date().toISOString(), id,
    );
}

/** Ids of the tasks that went to the trash with this project. */
export function taskIdsTrashedWith(sql: SqlStorage, projectId: string): string[] {
    return sql
        .exec<{ id: string }>("SELECT id FROM tasks WHERE trashed_with = ?", projectId)
        .toArray()
        .map((r) => r.id);
}

/** The task, only if it can have a Google event: not trashed, and its project isn't either. */
export function getTaskForSync(sql: SqlStorage, id: string): Task | null {
    const rows = sql
        .exec<TaskRow>(
            `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
             WHERE t.id = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`,
            id,
        )
        .toArray();
    return rows.length === 0 ? null : toTasks(rows)[0];
}

/** Scheduled tasks in the window, projected onto the timeline. */
export function taskCalendarItems(
    sql: SqlStorage,
    startISO: string,
    endISO: string,
    timeZone: string,
): CalendarItem[] {
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);

    const rows = sql
        .exec<TaskRow>(
            "SELECT * FROM tasks WHERE deleted_at IS NULL AND completed = 0 AND due_date IS NOT NULL AND due_date BETWEEN ? AND ?",
            startISO.slice(0, 10),
            endISO.slice(0, 10),
        )
        .toArray();

    const items: CalendarItem[] = [];
    for (const task of toTasks(rows)) {
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
