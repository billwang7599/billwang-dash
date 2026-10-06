import type { Goal, GoalInput, Horizon } from "../../shared/goals.ts";
import { nextOrder } from "./common.ts";

/** Goal storage. Plain functions over the DO's SQL handle; UserDO keeps the RPC methods. */

interface GoalRow extends Record<string, SqlStorageValue> {
    id: string;
    title: string;
    why: string;
    horizon: string;
    target: number | null;
    current: number;
    unit: string;
    deadline: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
    steps_done: number;
}

/** Goal columns plus how many of its steps are done (completed, not deleted). */
const SELECT_GOALS = `
    SELECT g.*, (SELECT COUNT(*) FROM tasks t
                 WHERE t.goal_id = g.id AND t.completed = 1 AND t.deleted_at IS NULL) AS steps_done
    FROM goals g`;

function toGoal(r: GoalRow): Goal {
    return {
        id: r.id,
        title: r.title,
        why: r.why,
        horizon: r.horizon as Horizon,
        target: r.target,
        current: r.current,
        unit: r.unit,
        deadline: r.deadline,
        sortOrder: r.sort_order,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        stepsDone: r.steps_done,
    };
}

export function listGoals(sql: SqlStorage): Goal[] {
    return sql
        .exec<GoalRow>(`${SELECT_GOALS} ORDER BY g.deadline, g.sort_order`)
        .toArray()
        .map(toGoal);
}

export function getGoal(sql: SqlStorage, id: string): Goal | null {
    const [row] = sql.exec<GoalRow>(`${SELECT_GOALS} WHERE g.id = ?`, id).toArray();
    return row ? toGoal(row) : null;
}

export function createGoal(sql: SqlStorage, input: GoalInput): Goal {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sql.exec(
        `INSERT INTO goals (id, title, why, horizon, target, current, unit, deadline, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.title, input.why, input.horizon, input.target, input.current, input.unit, input.deadline,
        nextOrder(sql, "goals"), now, now,
    );
    return getGoal(sql, id)!;
}

export function updateGoal(sql: SqlStorage, id: string, input: GoalInput): Goal | null {
    sql.exec(
        `UPDATE goals SET title = ?, why = ?, horizon = ?, target = ?, current = ?, unit = ?, deadline = ?,
         updated_at = ? WHERE id = ?`,
        input.title, input.why, input.horizon, input.target, input.current, input.unit, input.deadline,
        new Date().toISOString(), id,
    );
    return getGoal(sql, id);
}

export function setGoalProgress(sql: SqlStorage, id: string, current: number): Goal | null {
    sql.exec(
        "UPDATE goals SET current = ?, updated_at = ? WHERE id = ?",
        current, new Date().toISOString(), id,
    );
    return getGoal(sql, id);
}

export function deleteGoal(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM goals WHERE id = ?", id);
}
