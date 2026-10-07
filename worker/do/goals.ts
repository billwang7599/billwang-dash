import type { Goal, GoalInput, Horizon } from "../../shared/goals.ts";
import { civilFromDate, civilKey } from "../../shared/civil.ts";
import { nextOrder, profileTimeZone } from "./common.ts";
import { instantOf, resolveInstant, toIso } from "./time.ts";

/** Goal storage. Plain functions over the DO's SQL handle; UserDO keeps the RPC methods. */

interface GoalRow extends Record<string, SqlStorageValue> {
    id: string;
    title: string;
    why: string;
    horizon: string;
    target: number | null;
    current: number;
    unit: string;
    /** End of the deadline's day, epoch ms; deadline_tz is the zone it was set in. */
    deadline_at: number;
    deadline_tz: string | null;
    sort_order: number;
    created_at: number;
    updated_at: number;
    steps_done: number;
}

/** Goal columns plus how many of its steps are done (completed, not deleted). */
const SELECT_GOALS = `
    SELECT g.*, (SELECT COUNT(*) FROM tasks t
                 WHERE t.goal_id = g.id AND t.completed = 1 AND t.deleted_at IS NULL) AS steps_done
    FROM goals g`;

function toGoal(r: GoalRow, zone: string): Goal {
    return {
        id: r.id,
        title: r.title,
        why: r.why,
        horizon: r.horizon as Horizon,
        target: r.target,
        current: r.current,
        unit: r.unit,
        deadline: civilKey(civilFromDate(new Date(r.deadline_at), zone)),
        sortOrder: r.sort_order,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
        stepsDone: r.steps_done,
    };
}

export function listGoals(sql: SqlStorage): Goal[] {
    return sql
        .exec<GoalRow>(`${SELECT_GOALS} ORDER BY g.deadline_at, g.sort_order`)
        .toArray()
        .map((r) => toGoal(r, profileTimeZone(sql)));
}

export function getGoal(sql: SqlStorage, id: string): Goal | null {
    const [row] = sql.exec<GoalRow>(`${SELECT_GOALS} WHERE g.id = ?`, id).toArray();
    return row ? toGoal(row, profileTimeZone(sql)) : null;
}

export function createGoal(sql: SqlStorage, input: GoalInput): Goal {
    const id = crypto.randomUUID();
    const now = Date.now();
    const zone = profileTimeZone(sql);
    sql.exec(
        `INSERT INTO goals (id, title, why, horizon, target, current, unit, deadline_at, deadline_tz, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.title, input.why, input.horizon, input.target, input.current, input.unit,
        instantOf(input.deadline, null, zone), zone, nextOrder(sql, "goals"), now, now,
    );
    return getGoal(sql, id)!;
}

export function updateGoal(sql: SqlStorage, id: string, input: GoalInput): Goal | null {
    const [was] = sql.exec<{ deadline_at: number; deadline_tz: string | null }>(
        "SELECT deadline_at, deadline_tz FROM goals WHERE id = ?", id,
    ).toArray();
    const { at, tz } = resolveInstant(input.deadline, null, profileTimeZone(sql), was && {
        at: was.deadline_at, tz: was.deadline_tz, hasTime: false,
    });
    sql.exec(
        `UPDATE goals SET title = ?, why = ?, horizon = ?, target = ?, current = ?, unit = ?, deadline_at = ?,
         deadline_tz = ?, updated_at = ? WHERE id = ?`,
        input.title, input.why, input.horizon, input.target, input.current, input.unit, at,
        tz, Date.now(), id,
    );
    return getGoal(sql, id);
}

export function setGoalProgress(sql: SqlStorage, id: string, current: number): Goal | null {
    sql.exec(
        "UPDATE goals SET current = ?, updated_at = ? WHERE id = ?",
        current, Date.now(), id,
    );
    return getGoal(sql, id);
}

export function deleteGoal(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM goals WHERE id = ?", id);
}
