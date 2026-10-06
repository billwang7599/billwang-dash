import { useEffect, useMemo, useState } from "react";
import { civilKey, daysInMonth, weekday } from "../../shared/civil.ts";
import type { HabitDay, HabitSummary } from "../../shared/habits.ts";
import { api } from "../api.ts";
import { formatPlainDate } from "../format.ts";
import { cellState } from "../habitCells.ts";

interface Props {
    habits: HabitSummary[];
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    /** Bumps when a habit changes elsewhere (e.g. the sidebar check), so the month reloads. */
    revision: number;
    onChanged: (habit: HabitSummary) => void;
    onNew: () => void;
    onOpen: (id: string) => void;
}

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/** Every habit as a row, every day of the month as a column; a cell click checks that day off. */
export function HabitsView({ habits, today, revision, onChanged, onNew, onOpen }: Props) {
    const [month, setMonth] = useState(today.slice(0, 7));
    const [days, setDays] = useState<Record<string, HabitDay[]>>({});
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let stale = false;
        api.getHabitsMonth(month)
            .then((r) => !stale && setDays(r.days))
            .catch((e: Error) => !stale && setError(e.message));
        return () => {
            stale = true;
        };
    }, [month, revision]);

    const columns = useMemo(() => {
        const [y, m] = month.split("-").map(Number);
        return Array.from({ length: daysInMonth(y, m) }, (_, i) => {
            const c = { y, m, d: i + 1 };
            return { key: civilKey(c), n: i + 1, letter: WEEKDAY_LETTERS[weekday(c)] };
        });
    }, [month]);

    const statusOf = (habitId: string, key: string) => days[habitId]?.find((d) => d.day === key)?.status;

    async function toggle(habit: HabitSummary, key: string) {
        setError(null);
        const next = statusOf(habit.id, key) === "done" ? null : "done";
        try {
            const { habit: updated } = await api.setCheckin(habit.id, key, next);
            onChanged(updated);
            setDays((prev) => {
                const rest = (prev[habit.id] ?? []).filter((d) => d.day !== key);
                const kept = prev[habit.id]?.find((d) => d.day === key)?.note ?? "";
                return { ...prev, [habit.id]: next ? [...rest, { day: key, status: next, note: kept }] : rest };
            });
        } catch (e) {
            setError((e as Error).message);
        }
    }

    const shiftMonth = (by: number) => {
        const [y, m] = month.split("-").map(Number);
        const next = new Date(Date.UTC(y, m - 1 + by, 1));
        setMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`);
    };
    const [yy, mm] = month.split("-").map(Number);
    const monthName = new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString("en-US", {
        month: "long",
        timeZone: "UTC",
    });
    const doneToday = habits.filter((h) => h.today === "done").length;

    return (
        <div className="habits-view">
            <header className="habit-head">
                <div>
                    <h1 className="view-title">Habits</h1>
                    {habits.length > 0 && (
                        <p className="habit-freq">
                            {doneToday} of {habits.length} done today
                        </p>
                    )}
                </div>
                <div className="habit-actions">
                    <button className="btn btn-quiet" onClick={onNew}>
                        + New habit
                    </button>
                </div>
            </header>

            {error && <p className="banner banner-bad">{error}</p>}

            {habits.length === 0 ? (
                <p className="habit-empty">No habits yet. Add one to start tracking.</p>
            ) : (
                <section className="habit-month" aria-label="All habits this month">
                    <div className="habit-month-head">
                        <button className="habit-step" onClick={() => shiftMonth(-1)} aria-label="Previous month">
                            ←
                        </button>
                        <h2>
                            {monthName} {yy}
                        </h2>
                        <button
                            className="habit-step"
                            onClick={() => shiftMonth(1)}
                            disabled={month === today.slice(0, 7)}
                            aria-label="Next month"
                        >
                            →
                        </button>
                    </div>

                    <div className="hg-scroll">
                        <table className="hg">
                            <thead>
                                <tr>
                                    <th className="hg-corner" />
                                    {columns.map((c) => (
                                        <th key={c.key} className={c.key === today ? "is-today" : undefined}>
                                            <span className="hg-letter">{c.letter}</span>
                                            {c.n}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {habits.map((h) => (
                                    <tr key={h.id}>
                                        <th scope="row" className="hg-name">
                                            <button onClick={() => onOpen(h.id)}>{h.name}</button>
                                            <span className="hg-stats">
                                                {h.stats.streak} {h.stats.streakUnit}
                                                {h.stats.streak === 1 ? "" : "s"}
                                                {h.stats.rate !== null && ` · ${Math.round(h.stats.rate * 100)}%`}
                                            </span>
                                        </th>
                                        {columns.map((c) => {
                                            const status = statusOf(h.id, c.key);
                                            return (
                                                <td key={c.key}>
                                                    <button
                                                        type="button"
                                                        className={`habit-cell hg-cell ${cellState(h, c.key, status, today)}${c.key === today ? " is-today" : ""}`}
                                                        disabled={c.key > today}
                                                        onClick={() => toggle(h, c.key)}
                                                        aria-label={`${h.name}, ${formatPlainDate(c.key)}: ${status ?? "no check-in"}`}
                                                    />
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <ul className="habit-legend" aria-hidden="true">
                        <li><span className="habit-cell is-done" /> Done</li>
                        <li><span className="habit-cell is-skipped" /> Skipped</li>
                        <li><span className="habit-cell is-missed" /> Missed</li>
                    </ul>
                </section>
            )}
        </div>
    );
}
