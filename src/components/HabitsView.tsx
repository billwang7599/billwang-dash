import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, civilFromKey, civilKey, daysInMonth, weekday } from "../../shared/civil.ts";
import {
    describeFrequency,
    MAX_NOTE_LENGTH,
    weekProgress,
    type DayStatus,
    type HabitDay,
    type HabitInput,
    type HabitSummary,
} from "../../shared/habits.ts";
import { api } from "../api.ts";
import { formatPlainDate } from "../format.ts";
import { cellState, todayTally } from "../habitCells.ts";
import { optimistically } from "../optimistic.ts";
import { cardColor } from "../projectColors.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { HabitModal } from "./HabitModal.tsx";
import { Hero } from "./Hero.tsx";

interface Props {
    habits: HabitSummary[];
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    revision: number;
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
const STATE_WORDS: Record<string, string> = {
    "is-done": "Done",
    "is-skipped": "Skipped",
    "is-missed": "Missed",
    "is-pending": "Not checked in yet",
    "is-off": "Not due",
    "is-future": "Upcoming",
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Check-ins by month ("YYYY-MM"), then by habit id. */
type MonthCache = Record<string, Record<string, HabitDay[]>>;

const shiftMonthKey = (month: string, by: number) => {
    const [y, m] = month.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1 + by, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
};

export function HabitsView({ habits, today, revision, selectedId, onSelect, onChanged, onNew, onUpdate, onDelete, jump }: Props) {
    const [month, setMonth] = useState(today.slice(0, 7));
    const [day, setDay] = useState(today);
    const [shownToday, setShownToday] = useState(today);
    if (shownToday !== today) {
        setShownToday(today);
        if (day === shownToday) {
            setDay(today);
            if (month === shownToday.slice(0, 7)) setMonth(today.slice(0, 7));
        }
    }
    const [cache, setCache] = useState<MonthCache>({});
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const dayPanel = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!jump) return;
        setMonth(jump.day.slice(0, 7));
        setDay(jump.day);
    }, [jump]);

    const week = useMemo(() => {
        const t = civilFromKey(today)!;
        return Array.from({ length: 7 }, (_, i) => {
            const c = addDays(t, i - 6);
            return { key: civilKey(c), letter: WEEKDAY_HEADS[(weekday(c) + 6) % 7] };
        });
    }, [today]);

    // The shown month, plus last month while the past week still reaches into it.
    const needed = useMemo(() => [...new Set([month, week[0].key.slice(0, 7), today.slice(0, 7)])], [month, week, today]);
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

    const checkinOf = (habitId: string, key: string) => cache[key.slice(0, 7)]?.[habitId]?.find((d) => d.day === key);

    function setCheckin(habit: HabitSummary, key: string, status: DayStatus | null, note?: string) {
        const m = key.slice(0, 7);
        const before = cache[m]?.[habit.id] ?? [];
        const putDays = (days: HabitDay[]) => setCache((prev) => ({ ...prev, [m]: { ...prev[m], [habit.id]: days } }));
        const rest = before.filter((d) => d.day !== key);
        const kept = before.find((d) => d.day === key)?.note ?? "";
        putDays(status ? [...rest, { day: key, status, note: note ?? kept }] : rest);
        if (key === today) onChanged({ ...habit, today: status });
        optimistically(
            () => api.setCheckin(habit.id, key, status, note),
            ({ habit: saved }) => onChanged(saved),
            () => {
                putDays(before);
                onChanged(habit);
            },
            setError,
        );
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

    const tally = todayTally(habits, today);
    const weekLoaded = week.every(({ key }) => cache[key.slice(0, 7)]);
    const cardLine = (h: HabitSummary) => {
        const parts: string[] = [];
        if (h.freq === "weekly_count" && weekLoaded) {
            const statuses = week.flatMap(({ key }) => {
                const status = checkinOf(h.id, key)?.status;
                return status ? [[key, status] as const] : [];
            });
            const { done, required } = weekProgress(h.perWeek ?? 1, h.startDate, new Map(statuses), today);
            if (required > 0) parts.push(`${Math.min(done, required)} of ${required} this week`);
        }
        if (cellState(h, today, h.today ?? undefined, today) === "is-off") parts.push("Not due today");
        parts.push(h.stats.streak > 0 ? `${h.stats.streak} ${h.stats.streakUnit} streak` : "No streak yet");
        return parts.join(" · ");
    };
    const selState = selected ? cellState(selected, day, sel?.status, today) : "";
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
            {habits.length > 0 && (
                <Hero
                    kicker="Done today"
                    title={tally.due ? `${tally.done}/${tally.due}` : "Rest day"}
                    stats={[
                        { value: bestStreak, label: "best streak" },
                        {
                            value: rates.length ? `${Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100)}%` : "–",
                            label: "last 4 weeks",
                        },
                    ]}
                />
            )}

            {error && <p className="banner banner-bad">{error}</p>}

            {habits.length === 0 ? (
                <section className="habit-start">
                    <h2>Start a habit</h2>
                    <p>
                        Something you want to do regularly: every day, a few times a week or on set days. Tick it off here each day
                        and watch the streak grow.
                    </p>
                    <button className="btn btn-primary" onClick={onNew}>
                        Add your first habit
                    </button>
                </section>
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
                                    <small>{cardLine(h)}</small>
                                </button>
                                <span className="hcard-week" aria-label="Last 7 days">
                                    {week.map(({ key, letter }) => {
                                        const state = cellState(h, key, checkinOf(h.id, key)?.status, today);
                                        return (
                                            <span
                                                key={key}
                                                className={`hcard-day${key === today ? " is-today" : ""}`}
                                                title={`${formatPlainDate(key)}: ${STATE_WORDS[state]}`}
                                            >
                                                <span className={`hcard-dot ${state}`} />
                                                {letter}
                                            </span>
                                        );
                                    })}
                                </span>
                                <button
                                    className={`hcard-tick ${cellState(h, today, h.today ?? undefined, today)}`}
                                    onClick={() => setCheckin(h, today, h.today === "done" ? null : "done")}
                                    aria-pressed={h.today === "done"}
                                    aria-label={`${h.today === "done" ? "Undo" : "Check off"} ${h.name} today`}
                                    title={h.today === "done" ? "Done today. Click to undo" : "Check off today"}
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
                                    <span className="habit-month-label">
                                        {MONTH_NAMES[mm - 1]} {yy}
                                        {(month !== today.slice(0, 7) || day !== today) && (
                                            <button
                                                className="btn btn-quiet habit-today"
                                                onClick={() => {
                                                    setMonth(today.slice(0, 7));
                                                    setDay(today);
                                                }}
                                            >
                                                Today
                                            </button>
                                        )}
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
                                    {cells.map((cell, i) => {
                                        if (cell === null) return <span key={`lead-${i}`} />;
                                        const state = cellState(selected, cell.key, checkinOf(selected.id, cell.key)?.status, today);
                                        return (
                                            <button
                                                key={cell.key}
                                                type="button"
                                                className={`habit-cell ${state}${cell.key === today ? " is-today" : ""}${cell.key === day ? " is-selected" : ""}`}
                                                disabled={cell.key > today}
                                                onClick={() => {
                                                    setDay(cell.key);
                                                    dayPanel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                                                }}
                                                aria-pressed={cell.key === day}
                                                aria-label={`${selected.name}, ${formatPlainDate(cell.key)}: ${STATE_WORDS[state]}`}
                                            >
                                                {cell.n}
                                            </button>
                                        );
                                    })}
                                </div>

                                <ul className="habit-legend" aria-hidden="true">
                                    <li><span className="habit-cell is-done" /> Done</li>
                                    <li><span className="habit-cell is-skipped" /> Skipped</li>
                                    <li><span className="habit-cell is-missed" /> Missed</li>
                                    <li><span className="habit-cell is-off" /> Not due</li>
                                </ul>
                            </section>

                            <section
                                ref={dayPanel}
                                className="habit-day"
                                aria-label="Selected day"
                                style={{ ["--card-c" as string]: selectedColor }}
                            >
                                <p className="habit-day-kicker">
                                    {day === today ? "Today" : "Selected day"} · {STATE_WORDS[selState]}
                                </p>
                                <h3>{formatPlainDate(day)}</h3>
                                <div className="habit-day-actions" role="group" aria-label="Check-in for this day">
                                    <button
                                        className={`btn ${sel?.status === "done" ? "btn-primary" : "btn-quiet"}`}
                                        aria-pressed={sel?.status === "done"}
                                        onClick={() => setCheckin(selected, day, sel?.status === "done" ? null : "done")}
                                    >
                                        Done
                                    </button>
                                    <button
                                        className={`btn ${sel?.status === "skipped" ? "btn-primary" : "btn-quiet"}`}
                                        aria-pressed={sel?.status === "skipped"}
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
                                        if (sel && note !== sel.note) setCheckin(selected, day, sel.status, note);
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
