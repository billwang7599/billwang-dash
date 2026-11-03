import { useEffect, useMemo, useState } from "react";
import { addDays, civilFromKey, civilKey, daysInMonth, weekday } from "../../shared/civil.ts";
import { describeFrequency, MAX_NOTE_LENGTH, type DayStatus, type HabitDay, type HabitInput, type HabitSummary } from "../../shared/habits.ts";
import { api } from "../api.ts";
import { formatPlainDate } from "../format.ts";
import { cellState } from "../habitCells.ts";
import { cardColor } from "../projectColors.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { HabitModal } from "./HabitModal.tsx";
import { Hero } from "./Hero.tsx";

interface Props {
    habits: HabitSummary[];
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    selectedId?: string;
    onSelect: (id: string) => void;
    onChanged: (habit: HabitSummary) => void;
    onNew: () => void;
    onUpdate: (id: string, input: HabitInput) => Promise<void>;
    onDelete: (id: string) => void;
    /** A search result asked to see this day; each new object moves the page there. */
    jump?: { day: string } | null;
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

export function HabitsView({ habits, today, selectedId, onSelect, onChanged, onNew, onUpdate, onDelete, jump }: Props) {
    const [month, setMonth] = useState(today.slice(0, 7));
    const [day, setDay] = useState(today);
    const [cache, setCache] = useState<MonthCache>({});
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        if (!jump) return;
        setMonth(jump.day.slice(0, 7));
        setDay(jump.day);
    }, [jump]);

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
    }, [needed]);

    const checkinOf = (habitId: string, key: string) => cache[key.slice(0, 7)]?.[habitId]?.find((d) => d.day === key);

    async function setCheckin(habit: HabitSummary, key: string, status: DayStatus | null, note?: string) {
        setError(null);
        try {
            const { habit: updated } = await api.setCheckin(habit.id, key, status, note);
            onChanged(updated);
            const m = key.slice(0, 7);
            setCache((prev) => {
                const days = prev[m]?.[habit.id] ?? [];
                const rest = days.filter((d) => d.day !== key);
                const kept = days.find((d) => d.day === key)?.note ?? "";
                return { ...prev, [m]: { ...prev[m], [habit.id]: status ? [...rest, { day: key, status, note: note ?? kept }] : rest } };
            });
        } catch (e) {
            setError((e as Error).message);
        }
    }

    const selected = habits.find((h) => h.id === selectedId) ?? habits[0];
    const selectedColor = cardColor(selected ? habits.indexOf(selected) : 0);
    const sel = selected && checkinOf(selected.id, day);

    const cells = useMemo(() => {
        const [y, m] = month.split("-").map(Number);
        const lead = (weekday({ y, m, d: 1 }) + 6) % 7; // Monday-first
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
                                <button className="hcard-name" onClick={() => onSelect(h.id)} aria-pressed={h === selected}>
                                    <span>{h.name}</span>
                                    <small>
                                        {h.stats.streak > 0 ? `${h.stats.streak} ${h.stats.streakUnit} streak` : "No streak yet"}
                                    </small>
                                </button>
                                <span className="hcard-week" aria-label="Last 7 days">
                                    {week.map((key) => (
                                        <span
                                            key={key}
                                            className={`hcard-dot ${cellState(h, key, checkinOf(h.id, key)?.status, today)}`}
                                            title={formatPlainDate(key)}
                                        />
                                    ))}
                                </span>
                                <button
                                    className={`hcard-tick${h.today === "done" ? " is-done" : ""}`}
                                    onClick={() => setCheckin(h, today, h.today === "done" ? null : "done")}
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
                        <>
                            <section className="habit-month" aria-label={`${selected.name} by month`}>
                                <div className="habit-month-head">
                                    <h2 className="habit-month-name">
                                        <span className="nav-swatch" style={{ background: selectedColor }} />
                                        {selected.name}
                                    </h2>
                                    <div className="habit-month-actions">
                                        <button className="btn btn-quiet" onClick={() => setEditing(true)}>
                                            Edit
                                        </button>
                                        <button className="btn btn-quiet btn-quiet-danger" onClick={() => setDeleting(true)}>
                                            Delete
                                        </button>
                                    </div>
                                </div>
                                <p className="habit-desc">
                                    {describeFrequency(selected)}
                                    {selected.description && <span>{selected.description}</span>}
                                </p>

                                <div className="habit-month-stats">
                                    <div>
                                        <b>{selected.stats.streak}</b>
                                        {selected.stats.streakUnit} streak
                                    </div>
                                    <div>
                                        <b>{selected.stats.bestStreak}</b>best
                                    </div>
                                    <div>
                                        <b>{selected.stats.totalDone}</b>total days
                                    </div>
                                    <div>
                                        <b>{selected.stats.rate === null ? "–" : `${Math.round(selected.stats.rate * 100)}%`}</b>last 4 weeks
                                    </div>
                                </div>

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
                                                className={`habit-cell ${cellState(selected, cell.key, checkinOf(selected.id, cell.key)?.status, today)}${cell.key === today ? " is-today" : ""}${cell.key === day ? " is-selected" : ""}`}
                                                disabled={cell.key > today}
                                                onClick={() => setDay(cell.key)}
                                                aria-pressed={cell.key === day}
                                                aria-label={`${selected.name}, ${formatPlainDate(cell.key)}: ${checkinOf(selected.id, cell.key)?.status ?? "no check-in"}`}
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

                            <section className="habit-day" aria-label="Selected day" style={{ ["--card-c" as string]: selectedColor }}>
                                <p className="habit-day-kicker">Selected day</p>
                                <h3>{formatPlainDate(day)}</h3>
                                <div className="habit-day-actions" role="group" aria-label="Check-in for this day">
                                    <button
                                        className={`btn ${sel?.status === "done" ? "btn-primary" : "btn-quiet"}`}
                                        onClick={() => setCheckin(selected, day, sel?.status === "done" ? null : "done")}
                                    >
                                        Done
                                    </button>
                                    <button
                                        className={`btn ${sel?.status === "skipped" ? "btn-primary" : "btn-quiet"}`}
                                        onClick={() => setCheckin(selected, day, sel?.status === "skipped" ? null : "skipped")}
                                    >
                                        Skip
                                    </button>
                                    {sel && (
                                        <button className="btn btn-quiet" onClick={() => setCheckin(selected, day, null)}>
                                            Clear
                                        </button>
                                    )}
                                </div>
                                <NoteField
                                    // Re-mounting per habit, day and status keeps the draft from leaking between them.
                                    key={`${selected.id}:${day}:${sel?.status ?? "none"}`}
                                    initial={sel?.note ?? ""}
                                    enabled={!!sel}
                                    onCommit={(note) => {
                                        if (sel && note !== sel.note) void setCheckin(selected, day, sel.status, note);
                                    }}
                                />
                            </section>
                        </>
                    )}
                </div>
            )}

            {editing && selected && (
                <HabitModal habit={selected} onSave={(input) => onUpdate(selected.id, input)} onClose={() => setEditing(false)} />
            )}
            {deleting && selected && (
                <ConfirmDialog
                    title="Delete habit?"
                    message={`"${selected.name}" and all of its check-ins will be permanently deleted. This can't be undone.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        setDeleting(false);
                        onDelete(selected.id);
                    }}
                    onCancel={() => setDeleting(false)}
                />
            )}
        </div>
    );
}

const NOTE_WARN_AT = Math.floor(MAX_NOTE_LENGTH * 0.8);

function NoteField({ initial, enabled, onCommit }: { initial: string; enabled: boolean; onCommit: (note: string) => void }) {
    const [length, setLength] = useState(initial.length);
    const remaining = MAX_NOTE_LENGTH - length;
    return (
        <>
            <textarea
                className="modal-desc habit-note"
                defaultValue={initial}
                disabled={!enabled}
                maxLength={MAX_NOTE_LENGTH}
                rows={3}
                placeholder={enabled ? "Add a note about this day" : "Mark the day done or skipped to add a note"}
                aria-label="Note for this day"
                onChange={(e) => setLength(e.target.value.length)}
                onBlur={(e) => onCommit(e.target.value)}
            />
            {length >= NOTE_WARN_AT && (
                <p className={`habit-note-count${remaining === 0 ? " is-full" : ""}`} role="status">
                    {remaining === 0 ? "Character limit reached" : `${remaining} characters left`}
                </p>
            )}
        </>
    );
}
