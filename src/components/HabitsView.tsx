import { useEffect, useMemo, useState } from "react";
import { addDays, civilFromKey, civilKey, daysInMonth, weekday } from "../../shared/civil.ts";
import type { HabitDay, HabitSummary } from "../../shared/habits.ts";
import { api } from "../api.ts";
import { formatPlainDate } from "../format.ts";
import { cellState } from "../habitCells.ts";
import { cardColor } from "../projectColors.ts";
import { Hero } from "./Hero.tsx";

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

const WEEKDAY_HEADS = ["M", "T", "W", "T", "F", "S", "S"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Check-ins by month ("YYYY-MM"), then by habit id. */
type MonthCache = Record<string, Record<string, HabitDay[]>>;

const shiftMonthKey = (month: string, by: number) => {
    const [y, m] = month.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1 + by, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Every habit as a colour card you can tick today off from, with its last seven
 * days as dots; the selected habit's month sits beside them as a dot calendar.
 */
export function HabitsView({ habits, today, revision, onChanged, onNew, onOpen }: Props) {
    const [month, setMonth] = useState(today.slice(0, 7));
    const [cache, setCache] = useState<MonthCache>({});
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const week = useMemo(() => {
        const t = civilFromKey(today)!;
        return Array.from({ length: 7 }, (_, i) => civilKey(addDays(t, i - 6)));
    }, [today]);

    // The shown month, plus last month while the past week still reaches into it.
    const needed = useMemo(() => [...new Set([month, week[0].slice(0, 7), today.slice(0, 7)])], [month, week, today]);
    useEffect(() => {
        let stale = false;
        for (const m of needed) {
            api.getHabitsMonth(m)
                .then((r) => !stale && setCache((prev) => ({ ...prev, [m]: r.days })))
                .catch((e: Error) => !stale && setError(e.message));
        }
        return () => {
            stale = true;
        };
    }, [needed, revision]);

    const statusOf = (habitId: string, key: string) =>
        cache[key.slice(0, 7)]?.[habitId]?.find((d) => d.day === key)?.status;

    async function toggle(habit: HabitSummary, key: string) {
        setError(null);
        const next = statusOf(habit.id, key) === "done" ? null : "done";
        try {
            const { habit: updated } = await api.setCheckin(habit.id, key, next);
            onChanged(updated);
            const m = key.slice(0, 7);
            setCache((prev) => {
                const days = prev[m]?.[habit.id] ?? [];
                const rest = days.filter((d) => d.day !== key);
                const kept = days.find((d) => d.day === key)?.note ?? "";
                return { ...prev, [m]: { ...prev[m], [habit.id]: next ? [...rest, { day: key, status: next, note: kept }] : rest } };
            });
        } catch (e) {
            setError((e as Error).message);
        }
    }

    const selected = habits.find((h) => h.id === selectedId) ?? habits[0];
    const selectedIndex = selected ? habits.indexOf(selected) : 0;

    const cells = useMemo(() => {
        const [y, m] = month.split("-").map(Number);
        const lead = (weekday({ y, m, d: 1 }) + 6) % 7; // Monday-first, like the habit page
        const out: ({ key: string; n: number } | null)[] = Array.from({ length: lead }, () => null);
        for (let d = 1; d <= daysInMonth(y, m); d++) out.push({ key: civilKey({ y, m, d }), n: d });
        return out;
    }, [month]);

    const doneToday = habits.filter((h) => h.today === "done").length;
    const bestStreak = Math.max(0, ...habits.map((h) => h.stats.bestStreak));
    const rates = habits.map((h) => h.stats.rate).filter((r): r is number => r !== null);
    const [yy, mm] = month.split("-").map(Number);

    return (
        <div className="habits-view">
            <div className="view-bar">
                <button className="btn btn-primary" onClick={onNew}>
                    + New habit
                </button>
            </div>
            <Hero
                kicker="Done today"
                title={`${doneToday}/${habits.length}`}
                stats={[
                    { value: bestStreak, label: "best streak" },
                    {
                        value: rates.length ? `${Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100)}%` : "–",
                        label: "last 4 weeks",
                    },
                ]}
            />

            {error && <p className="banner banner-bad">{error}</p>}

            {habits.length === 0 ? (
                <p className="habit-empty">No habits yet. Add one to start tracking.</p>
            ) : (
                <div className="habits-layout">
                    <div className="stack">
                        {habits.map((h, i) => (
                            <div
                                key={h.id}
                                className={`hcard${h === selected ? " is-selected" : ""}`}
                                style={{ ["--card-c" as string]: cardColor(i) }}
                            >
                                <button className="hcard-name" onClick={() => setSelectedId(h.id)} aria-pressed={h === selected}>
                                    <span>{h.name}</span>
                                    <small>
                                        {h.stats.streak > 0 ? `${h.stats.streak} ${h.stats.streakUnit} streak` : "No streak yet"}
                                    </small>
                                </button>
                                <span className="hcard-week" aria-label="Last 7 days">
                                    {week.map((key) => (
                                        <span
                                            key={key}
                                            className={`hcard-dot ${cellState(h, key, statusOf(h.id, key), today)}`}
                                            title={formatPlainDate(key)}
                                        />
                                    ))}
                                </span>
                                <button
                                    className={`hcard-tick${h.today === "done" ? " is-done" : ""}`}
                                    onClick={() => toggle(h, today)}
                                    aria-pressed={h.today === "done"}
                                    aria-label={`${h.today === "done" ? "Undo" : "Check off"} ${h.name} today`}
                                >
                                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                        <path
                                            d="M2.5 8.5l3.5 3.5 7.5-8"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>

                    {selected && (
                        <section className="habit-month" aria-label={`${selected.name} by month`}>
                            <div className="habit-month-head">
                                <button className="habit-month-name" onClick={() => onOpen(selected.id)}>
                                    <span className="nav-swatch" style={{ background: cardColor(selectedIndex) }} />
                                    {selected.name} →
                                </button>
                                <div className="habit-month-nav">
                                    <button className="habit-step" onClick={() => setMonth(shiftMonthKey(month, -1))} aria-label="Previous month">
                                        ←
                                    </button>
                                    <span>
                                        {MONTH_NAMES[mm - 1]} {yy}
                                    </span>
                                    <button
                                        className="habit-step"
                                        onClick={() => setMonth(shiftMonthKey(month, 1))}
                                        disabled={month === today.slice(0, 7)}
                                        aria-label="Next month"
                                    >
                                        →
                                    </button>
                                </div>
                            </div>

                            <div className="habit-month-stats">
                                <div>
                                    <b>{selected.stats.streak}</b>streak
                                </div>
                                <div>
                                    <b>{selected.stats.bestStreak}</b>best
                                </div>
                                <div>
                                    <b>{selected.stats.rate === null ? "–" : `${Math.round(selected.stats.rate * 100)}%`}</b>last 4 weeks
                                </div>
                            </div>

                            <div className="habit-grid">
                                {WEEKDAY_HEADS.map((h, i) => (
                                    <span key={i} className="habit-grid-head">
                                        {h}
                                    </span>
                                ))}
                                {cells.map((cell, i) =>
                                    cell === null ? (
                                        <span key={`lead-${i}`} />
                                    ) : (
                                        <button
                                            key={cell.key}
                                            type="button"
                                            className={`habit-cell ${cellState(selected, cell.key, statusOf(selected.id, cell.key), today)}${cell.key === today ? " is-today" : ""}`}
                                            disabled={cell.key > today}
                                            onClick={() => toggle(selected, cell.key)}
                                            aria-label={`${selected.name}, ${formatPlainDate(cell.key)}: ${statusOf(selected.id, cell.key) ?? "no check-in"}`}
                                        >
                                            {cell.n}
                                        </button>
                                    ),
                                )}
                            </div>

                            <ul className="habit-legend" aria-hidden="true">
                                <li><span className="habit-cell is-done" /> Done</li>
                                <li><span className="habit-cell is-skipped" /> Skipped</li>
                                <li><span className="habit-cell is-missed" /> Missed</li>
                            </ul>
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
