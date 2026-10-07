import {
    computeStats,
    type DayStatus,
    type Habit,
    type HabitDay,
    type HabitDetail,
    type HabitFreq,
    type HabitInput,
    type HabitSummary,
} from "../../shared/habits.ts";
import { nextOrder } from "./common.ts";
import { toIso } from "./time.ts";

/**
 * Habit storage. Plain functions over the DO's SQL handle; UserDO keeps the RPC
 * methods and delegates here. `today` is the user's current day (YYYY-MM-DD), which
 * the DO works out from the profile's time zone.
 */

interface HabitRow extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    description: string;
    freq: string;
    per_week: number | null;
    weekdays: string;
    sort_order: number;
    created_at: number;
    start_date: string;
}

export function listHabits(sql: SqlStorage, today: string): HabitSummary[] {
    return summarize(
        sql,
        today,
        sql.exec<HabitRow>("SELECT * FROM habits ORDER BY sort_order, created_at").toArray(),
    );
}

export function createHabit(
    sql: SqlStorage,
    today: string,
    input: HabitInput,
): HabitSummary {
    const id = crypto.randomUUID();
    const now = Date.now();
    sql.exec(
        `INSERT INTO habits (id, name, description, freq, per_week, weekdays, sort_order, created_at, start_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.name, input.description, input.freq, input.perWeek, JSON.stringify(input.weekdays),
        nextOrder(sql, "habits"), now, today,
    );
    return getHabit(sql, today, id)!;
}

export function updateHabit(
    sql: SqlStorage,
    today: string,
    id: string,
    input: HabitInput,
): HabitSummary | null {
    sql.exec(
        "UPDATE habits SET name = ?, description = ?, freq = ?, per_week = ?, weekdays = ? WHERE id = ?",
        input.name, input.description, input.freq, input.perWeek, JSON.stringify(input.weekdays), id,
    );
    return getHabit(sql, today, id);
}

/** Check-ins go with it (ON DELETE CASCADE). */
export function deleteHabit(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM habits WHERE id = ?", id);
}

/** The habit and the check-ins in one month (YYYY-MM), for the monthly grid. */
export function getHabitDetail(
    sql: SqlStorage,
    today: string,
    id: string,
    month: string,
): HabitDetail | null {
    const habit = getHabit(sql, today, id);
    if (!habit) return null;
    const days = sql
        .exec<{ day: string; status: string; note: string }>(
            `SELECT day, status, note FROM habit_checkins
             WHERE habit_id = ? AND day >= ? AND day <= ? ORDER BY day`,
            id, `${month}-01`, `${month}-31`,
        )
        .toArray()
        .map((r) => ({ day: r.day, status: r.status as DayStatus, note: r.note }));
    return { habit, month, days };
}

/** Every habit's check-ins in one month (YYYY-MM), keyed by habit id, for the all-habits grid. */
export function getMonthCheckins(sql: SqlStorage, month: string): Record<string, HabitDay[]> {
    const out: Record<string, HabitDay[]> = {};
    const rows = sql
        .exec<{ habit_id: string; day: string; status: string; note: string }>(
            `SELECT habit_id, day, status, note FROM habit_checkins
             WHERE day >= ? AND day <= ? ORDER BY day`,
            `${month}-01`, `${month}-31`,
        )
        .toArray();
    for (const r of rows) {
        (out[r.habit_id] ??= []).push({ day: r.day, status: r.status as DayStatus, note: r.note });
    }
    return out;
}

/**
 * Sets or clears one day. `note` undefined keeps the existing note. The caller has
 * checked the day is real and not in the future.
 */
export function setHabitCheckin(
    sql: SqlStorage,
    today: string,
    id: string,
    day: string,
    status: DayStatus | null,
    note: string | undefined,
): HabitSummary | null {
    if (!getHabit(sql, today, id)) return null;

    if (status === null) {
        sql.exec("DELETE FROM habit_checkins WHERE habit_id = ? AND day = ?", id, day);
    } else {
        const [existing] = sql
            .exec<{ note: string }>(
                "SELECT note FROM habit_checkins WHERE habit_id = ? AND day = ?",
                id, day,
            )
            .toArray();
        sql.exec(
            `INSERT INTO habit_checkins (habit_id, day, status, note, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(habit_id, day) DO UPDATE SET status = excluded.status, note = excluded.note`,
            id, day, status, note ?? existing?.note ?? "", Date.now(),
        );
    }
    return getHabit(sql, today, id);
}

function getHabit(sql: SqlStorage, today: string, id: string): HabitSummary | null {
    const rows = sql.exec<HabitRow>("SELECT * FROM habits WHERE id = ?", id).toArray();
    return rows.length === 0 ? null : summarize(sql, today, rows)[0];
}

/** Stats for a batch of habits, reading every check-in in one query. */
function summarize(sql: SqlStorage, today: string, rows: HabitRow[]): HabitSummary[] {
    if (rows.length === 0) return [];

    const byHabit = new Map<string, Map<string, DayStatus>>();
    for (const c of sql
        .exec<{ habit_id: string; day: string; status: string }>(
            "SELECT habit_id, day, status FROM habit_checkins",
        )
        .toArray()) {
        let days = byHabit.get(c.habit_id);
        if (!days) byHabit.set(c.habit_id, (days = new Map()));
        days.set(c.day, c.status as DayStatus);
    }

    return rows.map((r) => {
        const checkins = byHabit.get(r.id) ?? new Map<string, DayStatus>();
        // Logging a day before the habit began moves the start back to it.
        const earliest = [...checkins.keys()].sort()[0];
        const startDate = earliest !== undefined && earliest < r.start_date ? earliest : r.start_date;
        const habit: Habit = {
            id: r.id,
            name: r.name,
            description: r.description,
            freq: r.freq as HabitFreq,
            perWeek: r.per_week,
            weekdays: JSON.parse(r.weekdays) as number[],
            order: r.sort_order,
            createdAt: toIso(r.created_at),
            startDate,
        };
        return { ...habit, stats: computeStats(habit, startDate, checkins, today), today: checkins.get(today) ?? null };
    });
}
