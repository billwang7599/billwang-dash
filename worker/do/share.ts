import { civilFromDate, civilKey, zonedToUtcMs } from "../../shared/civil.ts";
import { SHARE_MAX_DONE, type ShareInfo, type SharedView } from "../../shared/share.ts";
import type { Task } from "../../shared/types.ts";
import { INBOX_ID, profileTimeZone } from "./common.ts";
import * as taskStore from "./tasks.ts";

/**
 * Project share links. A project's `share_token` is the whole credential: whoever holds
 * it can see the project's open tasks, add tasks (up to `share_limit` a day) and tick
 * them off, and nothing else. Rotating overwrites the token; turning sharing off clears it.
 * Plain functions over the DO's SQL handle; UserDO keeps the RPC methods.
 */

interface SharedProject extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    color: string;
}

/** Midnight today in the user's zone, so the daily limit resets when their day does. */
function startOfToday(sql: SqlStorage): number {
    const zone = profileTimeZone(sql);
    return zonedToUtcMs(civilFromDate(new Date(), zone), 0, zone);
}

/** Trashed tasks still count, so a limit can't be reset by deleting what was added. */
function usedToday(sql: SqlStorage, projectId: string): number {
    return sql
        .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND via_link = 1 AND created_at >= ?",
            projectId, startOfToday(sql),
        )
        .one().n;
}

/** Null if there is no such project, or it is the Inbox, which is never shared. */
export function getShare(sql: SqlStorage, projectId: string): ShareInfo | null {
    const [row] = sql
        .exec<{ share_token: string | null; share_limit: number }>(
            "SELECT share_token, share_limit FROM projects WHERE id = ? AND id != ? AND deleted_at IS NULL",
            projectId, INBOX_ID,
        )
        .toArray();
    if (!row) return null;
    return {
        enabled: row.share_token !== null,
        token: row.share_token,
        limit: row.share_limit,
        usedToday: usedToday(sql, projectId),
    };
}

/** Turns sharing on, keeping the current link if there is one. */
export function enableShare(sql: SqlStorage, projectId: string): ShareInfo | null {
    const info = getShare(sql, projectId);
    if (!info) return null;
    if (info.enabled) return info;
    return writeToken(sql, projectId, crypto.randomUUID());
}

/** A new token for a project that is shared; the old link stops working at once. */
export function rotateShare(sql: SqlStorage, projectId: string): ShareInfo | null {
    const info = getShare(sql, projectId);
    if (!info) return null;
    return writeToken(sql, projectId, crypto.randomUUID());
}

export function disableShare(sql: SqlStorage, projectId: string): ShareInfo | null {
    return writeToken(sql, projectId, null);
}

export function setShareLimit(sql: SqlStorage, projectId: string, limit: number): ShareInfo | null {
    if (!getShare(sql, projectId)) return null;
    sql.exec("UPDATE projects SET share_limit = ? WHERE id = ?", limit, projectId);
    return getShare(sql, projectId);
}

function writeToken(sql: SqlStorage, projectId: string, token: string | null): ShareInfo | null {
    if (!getShare(sql, projectId)) return null;
    sql.exec("UPDATE projects SET share_token = ? WHERE id = ?", token, projectId);
    return getShare(sql, projectId);
}

function projectByToken(sql: SqlStorage, token: string): SharedProject | null {
    if (!token) return null;
    const [row] = sql
        .exec<SharedProject>(
            "SELECT id, name, color FROM projects WHERE share_token = ? AND id != ? AND deleted_at IS NULL",
            token, INBOX_ID,
        )
        .toArray();
    return row ?? null;
}

export function sharedView(sql: SqlStorage, token: string): SharedView | null {
    const project = projectByToken(sql, token);
    if (!project) return null;

    const viaLink = new Set(
        sql
            .exec<{ id: string }>("SELECT id FROM tasks WHERE project_id = ? AND via_link = 1", project.id)
            .toArray()
            .map((r) => r.id),
    );
    // Open tasks, then what visitors have ticked off. Ticked tasks the owner made are not
    // theirs to see, so only the ones added through the link stay on the page.
    const inProject = taskStore.listTasks(sql, { includeCompleted: true }).filter((t) => t.projectId === project.id);
    const open = inProject.filter((t) => !t.completed);
    const done = inProject
        .filter((t) => t.completed && viaLink.has(t.id))
        .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
        .slice(-SHARE_MAX_DONE);
    const tasks = [...open, ...done].map((t) => ({
        id: t.id,
        content: t.content,
        viaLink: viaLink.has(t.id),
        completed: t.completed,
    }));

    const { first_name } = sql.exec<{ first_name: string }>("SELECT first_name FROM profile WHERE id = 1").one();
    const { share_limit } = sql
        .exec<{ share_limit: number }>("SELECT share_limit FROM projects WHERE id = ?", project.id)
        .one();

    return {
        projectName: project.name,
        color: project.color,
        ownerName: first_name || null,
        tasks,
        remaining: Math.max(0, share_limit - usedToday(sql, project.id)),
    };
}

/** "limit" when today's quota is spent; null when the token matches nothing. */
export function addShared(sql: SqlStorage, token: string, content: string): Task | "limit" | null {
    const project = projectByToken(sql, token);
    if (!project) return null;

    const info = getShare(sql, project.id)!;
    if (info.usedToday >= info.limit) return "limit";

    // Plain text only: the quick-add parser would let a visitor set dates, priorities, projects.
    const task = taskStore.createTask(sql, { content, projectId: project.id });
    sql.exec("UPDATE tasks SET via_link = 1 WHERE id = ?", task.id);
    return task;
}

/** The ticked task, or null if the token or the task doesn't match. Only this project's tasks can be reached. Ticking one that is already done is not an error: two visitors can race. */
export function completeShared(sql: SqlStorage, token: string, taskId: string): Task | null {
    const project = projectByToken(sql, token);
    if (!project) return null;

    const task = taskStore.getTask(sql, taskId);
    if (!task || task.projectId !== project.id) return null;
    if (task.completed) return task;

    const today = civilKey(civilFromDate(new Date(), profileTimeZone(sql)));
    return taskStore.completeTask(sql, taskId, today);
}
