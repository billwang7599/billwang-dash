import type { Project } from "../../shared/types.ts";
import { INBOX_ID, nextOrder } from "./common.ts";

/**
 * Project storage. Plain functions over the DO's SQL handle; UserDO keeps the RPC
 * methods and delegates here, and owns anything that touches the Google push queue.
 */

export interface ProjectRow extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    color: string;
    is_inbox: number;
    sort_order: number;
    created_at: string;
    pinned: number;
    deleted_at: string | null;
}

export const toProject = (r: ProjectRow): Project => ({
    id: r.id,
    name: r.name,
    color: r.color,
    isInbox: r.is_inbox === 1,
    order: r.sort_order,
    createdAt: r.created_at,
    pinned: r.pinned === 1,
});

export function listProjects(sql: SqlStorage): Project[] {
    return sql
        .exec<ProjectRow>("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY is_inbox DESC, sort_order, name")
        .toArray()
        .map(toProject);
}

export function findProjectByName(sql: SqlStorage, name: string): Project | null {
    const [row] = sql
        .exec<ProjectRow>("SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1", name)
        .toArray();
    return row ? toProject(row) : null;
}

/** An existing project of the same name is returned as is. */
export function createProject(sql: SqlStorage, name: string, color = "slate"): Project {
    const existing = findProjectByName(sql, name);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const order = nextOrder(sql, "projects");
    const createdAt = new Date().toISOString();
    sql.exec(
        "INSERT INTO projects (id, name, color, is_inbox, sort_order, created_at) VALUES (?, ?, ?, 0, ?, ?)",
        id, name, color, order, createdAt,
    );
    return { id, name, color, isInbox: false, order, createdAt, pinned: false };
}

export function setProjectPinned(sql: SqlStorage, id: string, pinned: boolean): Project | null {
    sql.exec(
        "UPDATE projects SET pinned = ? WHERE id = ? AND deleted_at IS NULL",
        pinned ? 1 : 0, id,
    );
    const [row] = sql
        .exec<ProjectRow>("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", id)
        .toArray();
    return row ? toProject(row) : null;
}

export function setProjectColor(sql: SqlStorage, id: string, color: string): Project | null {
    sql.exec("UPDATE projects SET color = ? WHERE id = ? AND deleted_at IS NULL", color, id);
    const [row] = sql
        .exec<ProjectRow>("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", id)
        .toArray();
    return row ? toProject(row) : null;
}

/** Moves the project and its live tasks to the trash. False if the Inbox was targeted. */
export function trashProject(sql: SqlStorage, id: string): boolean {
    if (id === INBOX_ID) return false;
    const now = new Date().toISOString();
    // Tasks already in the trash were deleted on their own, so they are not
    // tagged and a restore of the project leaves them there.
    sql.exec(
        "UPDATE tasks SET deleted_at = ?, trashed_with = ? WHERE project_id = ? AND deleted_at IS NULL",
        now, id, id,
    );
    sql.exec("UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", now, id);
    return true;
}

export function hasProject(sql: SqlStorage, id: string): boolean {
    return sql.exec("SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL", id).toArray().length > 0;
}
