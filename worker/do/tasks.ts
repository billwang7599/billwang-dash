import {
    civilFromDate,
    civilFromKey,
    civilKey,
    minutesOfDay,
    minutesToTime,
    parseTimeToMinutes,
    zonedToUtcMs,
} from "../../shared/civil.ts";
import { nextOccurrence } from "../../shared/parser.ts";
import type { CalendarItem, DueDate, Priority, Recurrence, Task } from "../../shared/types.ts";
import { INBOX_ID, nextOrder, profileTimeZone } from "./common.ts";
import { END_OF_DAY_MINUTES, instantOf, resolveInstant, toIso, toIsoOrNull, toMs } from "./time.ts";
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
    /** Epoch ms of the due moment; a date-only task sits on the end of its day. */
    due_at: number | null;
    /** The zone the due time was set in; recurrence keeps its local time there. */
    due_tz: string | null;
    due_has_time: number;
    recurrence: string | null;
    /** End of the deadline's day, epoch ms; deadline_tz is the zone it was set in. */
    deadline_at: number | null;
    deadline_tz: string | null;
    duration_minutes: number | null;
    goal_id: string | null;
    completed: number;
    completed_at: number | null;
    sort_order: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
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

/** Tasks as the client sees them: due dates and times read in `zone`, the user's current one. */
export function toTasks(rows: TaskRow[], zone: string): Task[] {
    return rows.map((r) => ({
        id: r.id,
        content: r.content,
        description: r.description,
        projectId: r.project_id,
        priority: r.priority as Priority,
        due: r.due_at !== null
            ? {
                    date: civilKey(civilFromDate(new Date(r.due_at), zone)),
                    time: r.due_has_time ? minutesToTime(minutesOfDay(new Date(r.due_at), zone)) : null,
                    recurrence: r.recurrence
                        ? (JSON.parse(r.recurrence) as Recurrence)
                        : null,
                }
            : null,
        deadline: r.deadline_at === null ? null : civilKey(civilFromDate(new Date(r.deadline_at), zone)),
        durationMinutes: r.duration_minutes,
        goalId: r.goal_id,
        completed: r.completed === 1,
        completedAt: toIsoOrNull(r.completed_at),
        order: r.sort_order,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    }));
}

export function listTasks(sql: SqlStorage, options: { includeCompleted?: boolean } = {}): Task[] {
    const where = options.includeCompleted
        ? "WHERE deleted_at IS NULL"
        : "WHERE deleted_at IS NULL AND completed = 0";
    const rows = sql
        .exec<TaskRow>(
            `SELECT * FROM tasks ${where}
           ORDER BY due_at IS NULL, due_at, priority, sort_order`,
        )
        .toArray();
    return toTasks(rows, profileTimeZone(sql));
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
            toMs(before), toMs(before), projectId, projectId, limit + 1,
        )
        .toArray();
    return { tasks: toTasks(rows.slice(0, limit), profileTimeZone(sql)), more: rows.length > limit };
}

/** Tasks completed at or after an instant (ISO), e.g. since the start of this week. */
export function countCompletedSince(sql: SqlStorage, since: string): number {
    return sql
        .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM tasks WHERE completed = 1 AND deleted_at IS NULL AND completed_at >= ?",
            toMs(since),
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
            toMs(since),
        )
        .toArray();
    return Object.fromEntries(rows.map((r) => [r.project_id, r.n]));
}

export function getTask(sql: SqlStorage, id: string): Task | null {
    const rows = sql
        .exec<TaskRow>("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", id)
        .toArray();
    return rows.length === 0 ? null : toTasks(rows, profileTimeZone(sql))[0];
}

export function createTask(sql: SqlStorage, input: TaskInput): Task {
    const id = crypto.randomUUID();
    const now = Date.now();

    // A "#project" that doesn't exist yet is created on the fly, as Todoist does.
    let projectId = input.projectId ?? null;
    if (!projectId && input.projectName) {
        projectId = createProject(sql, input.projectName).id;
    }
    projectId ??= INBOX_ID;

    const due = input.due ?? null;
    const zone = profileTimeZone(sql);

    sql.exec(
        `INSERT INTO tasks (
           id, content, description, project_id, priority,
           due_at, due_tz, due_has_time, recurrence, deadline_at, deadline_tz, duration_minutes, goal_id,
           completed, completed_at, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
        id,
        input.content,
        input.description ?? "",
        projectId,
        input.priority ?? 4,
        due ? instantOf(due.date, due.time, zone) : null,
        due ? zone : null,
        due?.time ? 1 : 0,
        due?.recurrence ? JSON.stringify(due.recurrence) : null,
        input.deadline ? instantOf(input.deadline, null, zone) : null,
        input.deadline ? zone : null,
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
    if (patch.deadline !== undefined) {
        const was = sql.exec<{ deadline_at: number | null; deadline_tz: string | null }>(
            "SELECT deadline_at, deadline_tz FROM tasks WHERE id = ?", id,
        ).one();
        const { at, tz } = resolveInstant(patch.deadline || null, null, profileTimeZone(sql), {
            at: was.deadline_at, tz: was.deadline_tz, hasTime: false,
        });
        set("deadline_at", at);
        set("deadline_tz", tz);
    }
    if (patch.durationMinutes !== undefined) {
        set("duration_minutes", patch.durationMinutes);
    }
    if (patch.goalId !== undefined) set("goal_id", patch.goalId);
    if (patch.projectId !== undefined && patch.projectId) {
        set("project_id", patch.projectId);
    }
    if (patch.due !== undefined) {
        const was = sql.exec<{ due_at: number | null; due_tz: string | null; due_has_time: number }>(
            "SELECT due_at, due_tz, due_has_time FROM tasks WHERE id = ?", id,
        ).one();
        const { at, tz } = resolveInstant(patch.due?.date ?? null, patch.due?.time ?? null, profileTimeZone(sql), {
            at: was.due_at, tz: was.due_tz, hasTime: was.due_has_time === 1,
        });
        set("due_at", at);
        set("due_tz", tz);
        set("due_has_time", patch.due?.time ? 1 : 0);
        set("recurrence", patch.due?.recurrence ? JSON.stringify(patch.due.recurrence) : null);
    }

    if (sets.length > 0) {
        set("updated_at", Date.now());
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
    const now = Date.now();

    if (recurrence && task.due) {
        // Occurrences keep their local time in the zone the task was set in.
        const { due_at, due_tz } = sql
            .exec<{ due_at: number; due_tz: string | null }>("SELECT due_at, due_tz FROM tasks WHERE id = ?", id)
            .one();
        const zone = due_tz ?? profileTimeZone(sql);
        const scheduled = civilFromDate(new Date(due_at), zone);
        const today = civilFromKey(todayKey) ?? scheduled;
        const from = recurrence.fromCompletion ? today : scheduled;
        const next = nextOccurrence(recurrence, from, scheduled);
        const minutes = task.due.time ? minutesOfDay(new Date(due_at), zone) : END_OF_DAY_MINUTES;
        sql.exec(
            "UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ?",
            zonedToUtcMs(next, minutes, zone), now, id,
        );
        return getTask(sql, id);
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
        Date.now(), id,
    );
    return getTask(sql, id);
}

export function trashTask(sql: SqlStorage, id: string): void {
    sql.exec(
        "UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        Date.now(), id,
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
    return rows.length === 0 ? null : toTasks(rows, profileTimeZone(sql))[0];
}

const DAY_MS = 86_400_000;

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
            "SELECT * FROM tasks WHERE deleted_at IS NULL AND completed = 0 AND due_at BETWEEN ? AND ?",
            // A day's worth of slack either side; the overlap check below is exact.
            startMs - DAY_MS,
            endMs + DAY_MS,
        )
        .toArray();

    const items: CalendarItem[] = [];
    for (const task of toTasks(rows, timeZone)) {
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
