import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { civilKey, daysInMonth, weekday } from "../../shared/civil.ts";
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
import { cellState, dayTally, shiftMonth, stepWeek, weekOf } from "../habitCells.ts";
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
    /** The habit whose card is open, if any. */
    selectedId?: string;
    /** Opens a habit's card, or closes it with undefined. */
    onSelect: (id: string | undefined) => void;
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

/**
 * One list of habit cards under one day picker. The picked day (today unless you
 * pick another) is what every card's tick checks off; opening a card shows its
 * month, stats, skip and note for that same day.
 */
export function HabitsView({ habits, today, revision, selectedId, onSelect, onChanged, onNew, onUpdate, onDelete, jump }: Props) {
    const [day, setDayState] = useState(today);
    const [month, setMonth] = useState(today.slice(0, 7));
    const [shownToday, setShownToday] = useState(today);
    if (shownToday !== today) {
        setShownToday(today);
        if (day === shownToday) {
            setDayState(today);
            if (month === shownToday.slice(0, 7)) setMonth(today.slice(0, 7));
        }
    }
    const [cache, setCache] = useState<MonthCache>({});
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const tapAnchor = useRef<{ el: HTMLElement; top: number } | null>(null);
    const openCard = useRef<HTMLDivElement>(null);
    const fetchedAt = useRef<Record<string, number>>({});

    /** Picks a day for the whole page; the open card's month follows it. */
    function pickDay(key: string, from?: HTMLElement) {
        if (from && key !== day) tapAnchor.current = { el: from, top: from.getBoundingClientRect().top };
        setDayState(key);
        setMonth(key.slice(0, 7));
    }

    useEffect(() => {
        if (!jump) return;
        setDayState(jump.day);
        setMonth(jump.day.slice(0, 7));
    }, [jump]);

    const isToday = day === today;
    const dayWords = isToday ? "today" : `on ${formatPlainDate(day)}`;
    const week = useMemo(() => weekOf(day), [day]);

    const needed = useMemo(
        () => [...new Set([month, today.slice(0, 7), ...week.map((k) => k.slice(0, 7))])].filter((m) => m <= today.slice(0, 7)),
        [month, week, today],
    );
    // Refetching a loaded month on every day change would race a check-in and undo it on screen.
    useEffect(() => {
        for (const m of needed) {
            if (fetchedAt.current[m] === revision) continue;
            fetchedAt.current[m] = revision;
            api.getHabitsMonth(m)
                .then((r) => setCache((prev) => ({ ...prev, [m]: r.days })))
                .catch((e: Error) => {
                    delete fetchedAt.current[m];
                    setError(e.message);
                });
        }
    }, [needed, revision]);

    // Cards change height with the day; keep whatever was tapped under the finger.
    useLayoutEffect(() => {
        const anchor = tapAnchor.current;
        tapAnchor.current = null;
        if (anchor) window.scrollBy(0, anchor.el.getBoundingClientRect().top - anchor.top);
    }, [day]);

    // An opened card brings its details into view.
    useEffect(() => {
        if (selectedId) openCard.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, [selectedId]);

    const checkinOf = (habitId: string, key: string) => cache[key.slice(0, 7)]?.[habitId]?.find((d) => d.day === key);
    const statusOn = (habit: HabitSummary, key: string) =>
        key === today ? (habit.today ?? undefined) : checkinOf(habit.id, key)?.status;

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

    const selected = habits.find((h) => h.id === selectedId);
    const tally = dayTally(habits, day, (h) => statusOn(h, day));
    const weekLoaded = needed.every((m) => cache[m]);
    const cardLine = (h: HabitSummary) => {
        const parts: string[] = [];
        if (h.freq === "weekly_count" && weekLoaded) {
            const statuses = week.flatMap((key) => {
                const status = checkinOf(h.id, key)?.status;
                return status ? [[key, status] as const] : [];
            });
            const { done, required } = weekProgress(h.perWeek ?? 1, h.startDate, new Map(statuses), day);
            if (required > 0) parts.push(`${Math.min(done, required)} of ${required} ${isToday ? "this" : "that"} week`);
        }
        if (cellState(h, day, statusOn(h, day), day) === "is-off") parts.push(isToday ? "Not due today" : "Not due that day");
        parts.push(h.stats.streak > 0 ? `${h.stats.streak} ${h.stats.streakUnit} streak` : "No streak yet");
        return parts.join(" · ");
    };
    const bestStreak = Math.max(0, ...habits.map((h) => h.stats.bestStreak));
    const rates = habits.map((h) => h.stats.rate).filter((r): r is number => r !== null);
    const weekHasToday = week[6] >= today;

    return (
        <div className="habits-view">
            <div className="view-bar">
                {habits.length > 0 && !isToday && (
                    <button className="btn btn-quiet habit-today" onClick={() => pickDay(today)}>
                        ← Back to today
                    </button>
                )}
                <button className="btn btn-primary" onClick={onNew}>
                    + New habit
                </button>
            </div>
            {habits.length > 0 && (
                <Hero
                    kicker={isToday ? "Done today" : `Done on ${formatPlainDate(day)}`}
                    title={tally.due ? `${tally.done}/${tally.due}` : isToday ? "Rest day" : "Nothing due"}
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
                <>
                    <nav className="habit-week" aria-label="Pick a day">
                        <button className="habit-step" onClick={() => pickDay(stepWeek(day, -1, today))} aria-label="Previous week">
                            ←
                        </button>
                        <div className="habit-week-days">
                            {week.map((key, i) => {
                                const t = key > today ? null : dayTally(habits, key, (h) => statusOn(h, key));
                                const n = Number(key.slice(8));
                                return (
                                    <button
                                        key={key}
                                        className={`habit-wday${key === day ? " is-selected" : ""}${key === today ? " is-today" : ""}${
                                            t && t.due > 0 && t.done >= t.due ? " is-complete" : ""
                                        }`}
                                        disabled={key > today}
                                        aria-pressed={key === day}
                                        aria-label={`${formatPlainDate(key)}${key === today ? " (today)" : ""}${
                                            t ? (t.due ? `: ${t.done} of ${t.due} done` : ": nothing due") : ""
                                        }`}
                                        onClick={(e) => pickDay(key, e.currentTarget)}
                                    >
                                        <span>{WEEKDAY_HEADS[i]}</span>
                                        <b>{n}</b>
                                        <i
                                            className="habit-wday-bar"
                                            style={{ ["--p" as string]: t && t.due ? t.done / t.due : 0 }}
                                            aria-hidden="true"
                                        />
                                    </button>
                                );
                            })}
                        </div>
                        <button
                            className="habit-step"
                            onClick={() => pickDay(stepWeek(day, 1, today))}
                            disabled={weekHasToday}
                            aria-label="Next week"
                        >
                            →
                        </button>
                    </nav>

                    <div className="stack habit-list">
                        {habits.map((h, i) => {
                            const open = h === selected;
                            const status = statusOn(h, day);
                            const done = status === "done";
                            return (
                                <div
                                    key={h.id}
                                    ref={open ? openCard : undefined}
                                    className={`hcard${open ? " is-open" : ""}`}
                                    style={{ ["--card-c" as string]: cardColor(i) }}
                                >
                                    <div className="hcard-row">
                                        <button
                                            className="hcard-name"
                                            onClick={() => onSelect(open ? undefined : h.id)}
                                            aria-expanded={open}
                                            aria-controls={`habit-detail-${h.id}`}
                                        >
                                            <span className="hcard-title">
                                                <span>{h.name}</span>
                                                <svg className="hcard-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                                    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                </svg>
                                            </span>
                                            <small>{cardLine(h)}</small>
                                        </button>
                                        <span className="hcard-week" aria-hidden="true">
                                            {week.map((key, j) => {
                                                const state = cellState(h, key, statusOn(h, key), today);
                                                return (
                                                    <span key={key} className={`hcard-day${key === day ? " is-shown" : ""}`}>
                                                        <span className={`hcard-dot ${state}`} />
                                                        {WEEKDAY_HEADS[j]}
                                                    </span>
                                                );
                                            })}
                                        </span>
                                        <button
                                            className={`hcard-tick ${cellState(h, day, status, day)}`}
                                            onClick={() => setCheckin(h, day, done ? null : "done")}
                                            aria-pressed={done}
                                            aria-label={`${done ? "Undo" : "Check off"} ${h.name} ${dayWords}`}
                                            title={done ? `Done ${dayWords}. Click to undo` : `Check off ${dayWords}`}
                                        >
                                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
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
                                    {open && (
                                        <HabitDetail
                                            habit={h}
                                            day={day}
                                            today={today}
                                            month={month}
                                            onMonth={setMonth}
                                            onPickDay={pickDay}
                                            checkinOf={(key) => checkinOf(h.id, key)}
                                            statusOn={(key) => statusOn(h, key)}
                                            onCheckin={(status, note) => setCheckin(h, day, status, note)}
                                            onEdit={() => setEditing(true)}
                                            onDelete={() => setDeleting(true)}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
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

interface DetailProps {
    habit: HabitSummary;
    day: string;
    today: string;
    month: string;
    onMonth: (month: string) => void;
    onPickDay: (key: string, from: HTMLElement) => void;
    checkinOf: (key: string) => HabitDay | undefined;
    statusOn: (key: string) => DayStatus | undefined;
    onCheckin: (status: DayStatus | null, note?: string) => void;
    onEdit: () => void;
    onDelete: () => void;
}

/** An open card: what the habit is, how it's going, its month, and skip or note for the picked day. */
function HabitDetail({ habit, day, today, month, onMonth, onPickDay, checkinOf, statusOn, onCheckin, onEdit, onDelete }: DetailProps) {
    const [yy, mm] = month.split("-").map(Number);
    const cells = useMemo(() => {
        const lead = (weekday({ y: yy, m: mm, d: 1 }) + 6) % 7; // Monday-first
        const out: ({ key: string; n: number } | null)[] = Array.from({ length: lead }, () => null);
        for (let d = 1; d <= daysInMonth(yy, mm); d++) out.push({ key: civilKey({ y: yy, m: mm, d }), n: d });
        return out;
    }, [yy, mm]);
    const sel = checkinOf(day);
    const isToday = day === today;
    const dayName = isToday ? "today" : formatPlainDate(day);
    const skipped = sel?.status === "skipped";
    const s = habit.stats;

    return (
        <div className="hcard-detail" id={`habit-detail-${habit.id}`}>
            <p className="hcard-desc">
                {describeFrequency(habit)}
                {habit.description && <span>{habit.description}</span>}
            </p>

            <div className="hcard-stats">
                <div>
                    <b>{s.streak}</b>
                    {s.streakUnit} streak
                </div>
                <div>
                    <b>{s.bestStreak}</b>best
                </div>
                <div>
                    <b>{s.totalDone}</b>total days
                </div>
                <div>
                    <b>{s.rate === null ? "–" : `${Math.round(s.rate * 100)}%`}</b>last 4 weeks
                </div>
            </div>

            <section className="hcard-month" aria-label={`${habit.name} by month`}>
                <div className="hcard-month-nav">
                    <button className="habit-step" onClick={() => onMonth(shiftMonth(month, -1))} aria-label="Previous month">
                        ←
                    </button>
                    <span>
                        {MONTH_NAMES[mm - 1]} {yy}
                    </span>
                    <button
                        className="habit-step"
                        onClick={() => onMonth(shiftMonth(month, 1))}
                        disabled={month >= today.slice(0, 7)}
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
                        const state = cellState(habit, cell.key, statusOn(cell.key), today);
                        return (
                            <button
                                key={cell.key}
                                type="button"
                                className={`habit-cell ${state}${cell.key === today ? " is-today" : ""}${cell.key === day ? " is-selected" : ""}`}
                                disabled={cell.key > today}
                                onClick={(e) => onPickDay(cell.key, e.currentTarget)}
                                aria-pressed={cell.key === day}
                                aria-label={`Show ${formatPlainDate(cell.key)}: ${STATE_WORDS[state]}`}
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
                </ul>
            </section>

            <section className="hcard-dayfoot" aria-label={`${habit.name} ${dayName}`}>
                <div className="hcard-dayhead">
                    <span>
                        <b>{isToday ? "Today" : formatPlainDate(day)}</b> · {STATE_WORDS[cellState(habit, day, statusOn(day), today)]}
                    </span>
                    <button
                        className={`btn ${skipped ? "btn-primary" : "btn-quiet"}`}
                        aria-pressed={skipped}
                        onClick={() => onCheckin(skipped ? null : "skipped")}
                        title="A skipped day neither breaks nor extends the streak"
                    >
                        {skipped ? "Skipped" : `Skip ${isToday ? "today" : "this day"}`}
                    </button>
                </div>
                <NoteField
                    // Re-mounting per habit, day and status keeps the draft from leaking between them.
                    key={`${habit.id}:${day}:${sel?.status ?? "none"}`}
                    initial={sel?.note ?? ""}
                    enabled={!!sel}
                    onCommit={(note) => {
                        if (sel && note !== sel.note) onCheckin(sel.status, note);
                    }}
                />
            </section>

            <div className="hcard-actions">
                <button className="btn btn-quiet" onClick={onEdit}>
                    Edit
                </button>
                <button className="btn btn-quiet btn-quiet-danger" onClick={onDelete}>
                    Delete
                </button>
            </div>
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
                rows={2}
                placeholder={enabled ? "Add a note about this day" : "Tick or skip the day to add a note"}
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
