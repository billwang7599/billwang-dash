import type { Project, Task, Trash } from "../../shared/types.ts";
import { findProjectByName, toProject, type ProjectRow } from "./projects.ts";
import { profileTimeZone } from "./common.ts";
import { toIso } from "./time.ts";
import { getTask, toTasks, type TaskRow } from "./tasks.ts";

/**
 * The trash: soft-deleted projects and tasks. UserDO tells the Google push queue
 * about the tasks that come back.
 */

export function getTrash(sql: SqlStorage): Trash {
    const projectRows = sql
        .exec<ProjectRow>(
            "SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
        .toArray();
    const projects = projectRows.map((r) => ({
        ...toProject(r),
        deletedAt: toIso(r.deleted_at!),
        // Only the tasks that went with it; ones trashed earlier stay behind on restore.
        taskCount: sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE trashed_with = ?", r.id)
            .one().n,
    }));

    // A task inside a trashed project is covered by that project's row.
    const taskRows = sql
        .exec<TaskRow>(
            `SELECT * FROM tasks
             WHERE deleted_at IS NOT NULL
               AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
             ORDER BY deleted_at DESC`,
        )
        .toArray();
    const tasks = toTasks(taskRows, profileTimeZone(sql)).map((t, i) => ({
        ...t,
        deletedAt: toIso(taskRows[i].deleted_at!),
    }));

    return { projects, tasks };
}

/**
 * Brings back the project and the tasks that were trashed with it. Refused if
 * a live project now has the same name, so names stay unique.
 */
export function restoreProject(
    sql: SqlStorage,
    id: string,
): { project: Project } | { error: "not_found" } | { error: "name_taken"; name: string } {
    const [row] = sql
        .exec<ProjectRow>("SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL", id)
        .toArray();
    if (!row) return { error: "not_found" };
    if (findProjectByName(sql, row.name)) return { error: "name_taken", name: row.name };

    sql.exec("UPDATE tasks SET deleted_at = NULL, trashed_with = NULL WHERE trashed_with = ?", id);
    sql.exec("UPDATE projects SET deleted_at = NULL WHERE id = ?", id);
    return { project: toProject({ ...row, deleted_at: null }) };
}

/** Null if the task isn't in the trash or its project still is. */
export function restoreTask(sql: SqlStorage, id: string): Task | null {
    sql.exec(
        `UPDATE tasks SET deleted_at = NULL
         WHERE id = ? AND deleted_at IS NOT NULL
           AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
        id,
    );
    return getTask(sql, id);
}

// Permanent deletes only touch rows already in the trash. Tasks go with their
// project via ON DELETE CASCADE (foreign keys are on).

export function purgeProject(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL", id);
}

export function purgeTask(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM tasks WHERE id = ? AND deleted_at IS NOT NULL", id);
}

export function emptyTrash(sql: SqlStorage): void {
    sql.exec("DELETE FROM projects WHERE deleted_at IS NOT NULL");
    sql.exec("DELETE FROM tasks WHERE deleted_at IS NOT NULL");
}
