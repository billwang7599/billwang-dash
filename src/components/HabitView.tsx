import { useCallback, useEffect, useMemo, useState } from "react";
import { civilKey, daysInMonth, weekday } from "../../shared/civil.ts";
import { describeFrequency, type DayStatus, type HabitDay, type HabitInput, type HabitSummary } from "../../shared/habits.ts";
import { api } from "../api.ts";
import { formatPlainDate } from "../format.ts";
import { cellState } from "../habitCells.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { HabitModal } from "./HabitModal.tsx";
import { Hero } from "./Hero.tsx";

interface Props {
    habit: HabitSummary;
    /** Its card colour on the Habits page, carried over here. */
    color: string;
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    /** Bumps when the sidebar changes this habit, so the month is reloaded. */
    revision: number;
    /** Any change made here, so the sidebar and its streak stay current. */
    onChanged: (habit: HabitSummary) => void;
    onUpdate: (id: string, input: HabitInput) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    onBack: () => void;
}

const WEEKDAY_HEADS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function HabitView({ habit, color, today, revision, onChanged, onUpdate, onDelete, onBack }: Props) {
    const [month, setMonth] = useState(today.slice(0, 7));
    const [days, setDays] = useState<HabitDay[]>([]);
    const [selected, setSelected] = useState(today);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // A different habit starts back on today.
    useEffect(() => {
        setMonth(today.slice(0, 7));
        setSelected(today);
    }, [habit.id, today]);

    useEffect(() => {
        let stale = false;
        api.getHabit(habit.id, month)
            .then((d) => !stale && setDays(d.days))
            .catch((e: Error) => !stale && setError(e.message));
        return () => {
            stale = true;
        };
    }, [habit.id, month, revision]);

    const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);

    const cells = useMemo(() => {
        const [y, m] = month.split("-").map(Number);
        const first = { y, m, d: 1 };
        const lead = (weekday(first) + 6) % 7; // Monday-first
        const out: ({ key: string; n: number } | null)[] = Array.from({ length: lead }, () => null);
        for (let d = 1; d <= daysInMonth(y, m); d++) out.push({ key: civilKey({ y, m, d }), n: d });
        return out;
    }, [month]);

    const shiftMonth = (by: number) => {
        const [y, m] = month.split("-").map(Number);
        const next = new Date(Date.UTC(y, m - 1 + by, 1));
        setMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`);
    };

    const setDay = useCallback(
        async (day: string, status: DayStatus | null, note?: string) => {
            setError(null);
            try {
                const { habit: updated } = await api.setCheckin(habit.id, day, status, note);
                onChanged(updated);
                setDays((prev) => {
                    const rest = prev.filter((d) => d.day !== day);
                    if (status === null) return rest;
                    const kept = prev.find((d) => d.day === day)?.note ?? "";
                    return [...rest, { day, status, note: note ?? kept }].sort((a, b) => a.day.localeCompare(b.day));
                });
            } catch (e) {
                setError((e as Error).message);
            }
        },
        [habit.id, onChanged],
    );

    const stateOf = (key: string) => cellState(habit, key, byDay.get(key)?.status, today);

    const { stats } = habit;
    const unit = stats.streakUnit === "week" ? "week" : "day";
    const [yy, mm] = month.split("-").map(Number);
    const isCurrentMonth = month === today.slice(0, 7);
    const sel = byDay.get(selected);

    return (
        <div className="habit-view">
            <div className="view-bar is-start">
                <button className="back-link" onClick={onBack}>
                    ← Habits
                </button>
                <button className="btn btn-quiet" onClick={() => setEditing(true)}>
                    Edit
                </button>
                <button className="btn btn-quiet btn-quiet-danger" onClick={() => setDeleting(true)}>
                    Delete
                </button>
            </div>
            <Hero
                kicker={describeFrequency(habit)}
                title={habit.name}
                accent={color}
                stats={[
                    { value: stats.streak, label: `${unit} streak` },
                    { value: stats.bestStreak, label: "best" },
                    { value: stats.totalDone, label: "total days" },
                    { value: stats.rate === null ? "–" : `${Math.round(stats.rate * 100)}%`, label: "last 4 weeks" },
                ]}
            />
            {habit.description && <p className="habit-desc">{habit.description}</p>}

            {error && <p className="banner banner-bad">{error}</p>}

            <div className="habit-page-cols">
                <section className="habit-month" aria-label="Monthly check-ins">
                    <div className="habit-month-head">
                        <button className="habit-step" onClick={() => shiftMonth(-1)} aria-label="Previous month">
                            ←
                        </button>
                        <h2>
                            {MONTH_NAMES[mm - 1]} {yy}
                        </h2>
                        <button className="habit-step" onClick={() => shiftMonth(1)} disabled={isCurrentMonth} aria-label="Next month">
                            →
                        </button>
                    </div>

                    <div className="habit-grid">
                        {WEEKDAY_HEADS.map((h) => (
                            <span key={h} className="habit-grid-head">
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
                                    className={`habit-cell ${stateOf(cell.key)}${cell.key === today ? " is-today" : ""}${cell.key === selected ? " is-selected" : ""}`}
                                    disabled={cell.key > today}
                                    onClick={() => setSelected(cell.key)}
                                    aria-label={`${formatPlainDate(cell.key)}: ${byDay.get(cell.key)?.status ?? "no check-in"}`}
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

                <section className="habit-day" aria-label="Selected day" style={{ ["--card-c" as string]: color }}>
                    <p className="habit-day-kicker">Selected day</p>
                    <h3>{formatPlainDate(selected)}</h3>
                    <div className="habit-day-actions" role="group" aria-label="Check-in for this day">
                        <button
                            className={`btn ${sel?.status === "done" ? "btn-primary" : "btn-quiet"}`}
                            onClick={() => setDay(selected, sel?.status === "done" ? null : "done")}
                        >
                            Done
                        </button>
                        <button
                            className={`btn ${sel?.status === "skipped" ? "btn-primary" : "btn-quiet"}`}
                            onClick={() => setDay(selected, sel?.status === "skipped" ? null : "skipped")}
                        >
                            Skip
                        </button>
                        {sel && (
                            <button className="btn btn-quiet" onClick={() => setDay(selected, null)}>
                                Clear
                            </button>
                        )}
                    </div>
                    <textarea
                        // Re-mounting per day and status keeps the draft from leaking between days.
                        key={`${selected}:${sel?.status ?? "none"}`}
                        className="modal-desc habit-note"
                        defaultValue={sel?.note ?? ""}
                        disabled={!sel}
                        maxLength={500}
                        rows={3}
                        placeholder={sel ? "Add a note about this day" : "Mark the day done or skipped to add a note"}
                        aria-label="Note for this day"
                        onBlur={(e) => {
                            if (sel && e.target.value !== sel.note) void setDay(selected, sel.status, e.target.value);
                        }}
                    />
                </section>
            </div>

            {editing && (
                <HabitModal habit={habit} onSave={(input) => onUpdate(habit.id, input)} onClose={() => setEditing(false)} />
            )}
            {deleting && (
                <ConfirmDialog
                    title="Delete habit?"
                    message={`"${habit.name}" and all of its check-ins will be permanently deleted. This can't be undone.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        setDeleting(false);
                        void onDelete(habit.id);
                    }}
                    onCancel={() => setDeleting(false)}
                />
            )}
        </div>
    );
}
