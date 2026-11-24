import { useEffect, useRef, useState } from "react";
import { isDone, type Goal } from "../../shared/goals.ts";
import type { Project, Recurrence, Task } from "../../shared/types.ts";
import { FINISH_BY_PICKS, finishByDates, parseFinishBy } from "../finishBy.ts";
import { formatDateLabel, formatDueLabel, formatRecurrence } from "../format.ts";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";

interface Props {
    task: Task;
    projects: Project[];
    goals: Goal[];
    /** Project id -> card colour; the band at the top takes the chosen project's (goals get none). */
    colors: Map<string, string>;
    /** The user's zone, so the quick picks' "today" is theirs and not the device's. */
    timeZone: string;
    /** How "3/4" reads, as in quick-add. */
    dateFormat: "MDY" | "DMY";
    onSave: (patch: Record<string, unknown>) => Promise<void>;
    /** Hands over to the delete confirmation. */
    onDelete: () => void;
    onClose: () => void;
}

/** Goal steps live in the Inbox project, so a task is in a project or on a goal, never both. */
const INBOX_ID = "inbox";

const FREQS = ["daily", "weekly", "monthly", "yearly"] as const;
const UNITS = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" } as const;
const PRIORITIES = [
    ["1", "Urgent"],
    ["2", "High"],
    ["3", "Medium"],
    ["4", "Normal"],
] as const;

export function TaskModal({ task, projects, goals, colors, timeZone, dateFormat, onSave, onDelete, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [content, setContent] = useState(task.content);
    const [description, setDescription] = useState(task.description);
    const [projectId, setProjectId] = useState(task.projectId);
    const [goalId, setGoalId] = useState(task.goalId ?? "");
    const [priority, setPriority] = useState(String(task.priority));
    const [dueDate, setDueDate] = useState(task.due?.date ?? "");
    const [dueTime, setDueTime] = useState(task.due?.time ?? "");
    const [deadline, setDeadline] = useState(task.deadline ?? "");
    const [duration, setDuration] = useState(
        task.durationMinutes === null ? "" : String(task.durationMinutes),
    );
    const [freq, setFreq] = useState<string>(task.due?.recurrence?.freq ?? "none");
    const [interval, setInterval] = useState(String(task.due?.recurrence?.interval ?? 1));

    // Time, repeat, duration and deadline are rarely used, so they start folded away,
    // unless this task already has one of them; nothing set is ever hidden.
    const [moreOpen, setMoreOpen] = useState(
        Boolean(task.due?.time || task.due?.recurrence || task.deadline || task.durationMinutes),
    );
    const [picks] = useState(() => finishByDates(new Date(), timeZone));

    // The Finish by box shows the date while idle and takes words ("fri", "dec 5 5pm",
    // "every monday") while focused, read by the same parser as quick-add.
    const [typing, setTyping] = useState<string | null>(null);
    const [typoHint, setTypoHint] = useState<string | null>(null);
    const typed = typing === null ? null : parseFinishBy(typing, { timeZone, dateFormat });
    const shownDue = dueDate ? formatDateLabel(dueDate, timeZone) : "";

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const titleRef = useRef<HTMLInputElement>(null);

    useEffect(() => titleRef.current?.focus(), []);

    // The rule whose specific days are kept while its frequency is untouched: the
    // task's own, or one typed into Finish by ("every mon and thu").
    const [original, setOriginal] = useState<Recurrence | null>(task.due?.recurrence ?? null);

    /** Applies the typed text, if it reads as a date; otherwise changes nothing and says so. */
    function commitTyping() {
        if (typing === null) return;
        const text = typing.trim();
        setTyping(null);
        if (text === "" || text === shownDue) return;
        if (!typed) {
            setTypoHint(`Couldn't read “${text}” as a date. Try “fri”, “in 3 days” or “dec 5 5pm”.`);
            return;
        }
        setDueDate(typed.date);
        if (typed.time) setDueTime(typed.time);
        if (typed.recurrence) {
            setOriginal(typed.recurrence);
            setFreq(typed.recurrence.freq);
            setInterval(String(typed.recurrence.interval));
        }
        if (typed.time || typed.recurrence) setMoreOpen(true);
    }

    function moveTo(value: string) {
        const [kind, id] = [value[0], value.slice(2)];
        setGoalId(kind === "g" ? id : "");
        if (kind === "p") setProjectId(id);
        else setProjectId(INBOX_ID);
    }

    function buildRecurrence(): Recurrence | null {
        if (freq === "none") return null;
        const n = Math.max(1, Number(interval) || 1);
        // Changing the frequency invalidates day-of-week/day-of-month pins, so
        // they are only carried over when the frequency is untouched.
        const same = original?.freq === freq;
        return {
            freq: freq as Recurrence["freq"],
            interval: n,
            weekdays: same ? original.weekdays : [],
            month: same ? original.month : null,
            monthDay: same ? original.monthDay : null,
            fromCompletion: original?.fromCompletion ?? false,
        };
    }

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (!content.trim() || busy) return;

        setBusy(true);
        setError(null);
        try {
            await onSave({
                content: content.trim(),
                description,
                projectId,
                goalId: goalId || null,
                priority: Number(priority),
                deadline: deadline || null,
                durationMinutes: duration ? Number(duration) : null,
                due: dueDate
                    ? {
                            date: dueDate,
                            time: dueTime || null,
                            recurrence: buildRecurrence(),
                        }
                    : null,
            });
            close();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <Modal label="Edit task" closing={closing} onClose={close}>
            <form onSubmit={save}>
                {/* Where the task lives: one project or one goal, in that project's colour. */}
                <label className="modal-band" style={{ ["--card-c" as string]: goalId ? undefined : colors.get(projectId) }}>
                    <span className="nav-swatch" aria-hidden="true" />
                    <select value={goalId ? `g:${goalId}` : `p:${projectId}`} onChange={(e) => moveTo(e.target.value)} aria-label="Project or goal">
                        <optgroup label="Projects">
                            {projects.map((p) => (
                                <option key={p.id} value={`p:${p.id}`}>
                                    {p.name}
                                </option>
                            ))}
                        </optgroup>
                        {/* Finished goals stay out of the way, unless this task is already on one. */}
                        <optgroup label="Goals">
                            {goals
                                .filter((g) => !isDone(g) || g.id === task.goalId)
                                .map((g) => (
                                    <option key={g.id} value={`g:${g.id}`}>
                                        {g.title}
                                    </option>
                                ))}
                        </optgroup>
                    </select>
                    <span className="modal-band-hint" aria-hidden="true">
                        change ›
                    </span>
                </label>

                <input
                    ref={titleRef}
                    className="modal-title"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Task name"
                    aria-label="Task name"
                />

                <textarea
                    className="modal-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Description"
                    aria-label="Description"
                    rows={3}
                />

                <div className="modal-finish">
                    <div className="modal-finish-date">
                        <label htmlFor="task-finish-by">Finish by</label>
                        <div className="modal-finish-inputs">
                            <input
                                id="task-finish-by"
                                className="modal-finish-text"
                                value={typing ?? shownDue}
                                placeholder="fri, in 3 days, dec 5…"
                                autoComplete="off"
                                aria-describedby="task-finish-preview"
                                onFocus={(e) => {
                                    setTyping(shownDue);
                                    setTypoHint(null);
                                    e.currentTarget.select();
                                }}
                                onChange={(e) => {
                                    setTyping(e.target.value);
                                    setTypoHint(null);
                                }}
                                onBlur={commitTyping}
                                onKeyDown={(e) => {
                                    // Enter applies the date rather than saving the whole task;
                                    // Escape backs out of the typing without touching anything.
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        commitTyping();
                                    } else if (e.key === "Escape" && typing !== null) {
                                        e.stopPropagation();
                                        setTyping(null);
                                    }
                                }}
                            />
                            <input
                                type="date"
                                className="modal-finish-cal"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                                aria-label="Finish by, from a calendar"
                            />
                        </div>
                    </div>
                    <div className="modal-finish-picks" role="group" aria-label="Finish by">
                        {FINISH_BY_PICKS.map(([key, label]) => (
                            <button
                                key={key}
                                type="button"
                                aria-pressed={dueDate === picks[key]}
                                className={`pill-btn${dueDate === picks[key] ? " is-on" : ""}`}
                                onClick={() => setDueDate(picks[key])}
                            >
                                {label}
                            </button>
                        ))}
                        <button
                            type="button"
                            aria-pressed={!dueDate}
                            className={`pill-btn${!dueDate ? " is-on" : ""}`}
                            onClick={() => setDueDate("")}
                        >
                            None
                        </button>
                    </div>
                    <p id="task-finish-preview" className="modal-finish-preview" aria-live="polite">
                        {typing !== null && typing.trim() !== "" && typing.trim() !== shownDue
                            ? typed
                                ? <span className="pill pill-date">{formatDueLabel(typed, timeZone)}</span>
                                : "Keep typing a date, like “fri” or “dec 5”"
                            : typoHint}
                    </p>
                </div>

                {/* Few options, so pills you can see at once rather than dropdowns. */}
                <div className="modal-pills" role="radiogroup" aria-label="Priority">
                    <span>Priority</span>
                    {PRIORITIES.map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={priority === value}
                            className={`pill-btn${priority === value ? " is-on" : ""}`}
                            onClick={() => setPriority(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    className="modal-more"
                    aria-expanded={moreOpen}
                    aria-controls="task-more"
                    onClick={() => setMoreOpen((o) => !o)}
                >
                    <span className="modal-more-caret" aria-hidden="true">
                        ›
                    </span>
                    More options
                    {!moreOpen && <span className="modal-more-hint">time, repeat, duration, deadline</span>}
                </button>

                {moreOpen && (
                    <div id="task-more" className="modal-more-body">
                        <div className="modal-grid">
                            <label>
                                <span>Time</span>
                                <input
                                    type="time"
                                    value={dueTime}
                                    onChange={(e) => setDueTime(e.target.value)}
                                    disabled={!dueDate}
                                />
                            </label>

                            <label>
                                <span>Duration (min)</span>
                                <input
                                    type="number"
                                    min={0}
                                    step={5}
                                    value={duration}
                                    onChange={(e) => setDuration(e.target.value)}
                                    placeholder="—"
                                />
                            </label>

                            <label>
                                <span>Hard deadline</span>
                                <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                            </label>
                        </div>

                        <div className="modal-pills" role="radiogroup" aria-label="Repeat">
                            <span>Repeat{!dueDate && " (needs a finish-by date)"}</span>
                            {(["none", ...FREQS] as const).map((f) => (
                                <button
                                    key={f}
                                    type="button"
                                    role="radio"
                                    aria-checked={freq === f}
                                    className={`pill-btn${freq === f ? " is-on" : ""}`}
                                    disabled={!dueDate}
                                    onClick={() => setFreq(f)}
                                >
                                    {f === "none" ? "Never" : f[0].toUpperCase() + f.slice(1)}
                                </button>
                            ))}
                            {freq !== "none" && dueDate && (
                                <label className="modal-every">
                                    every
                                    <input
                                        type="number"
                                        min={1}
                                        value={interval}
                                        onChange={(e) => setInterval(e.target.value)}
                                        aria-label="Repeat interval"
                                    />
                                    {UNITS[freq as (typeof FREQS)[number]]}
                                </label>
                            )}
                        </div>

                        {original && original.weekdays.length > 0 && freq === original.freq && (
                            <p className="modal-note">
                                Keeping “{formatRecurrence(original)}”. Changing Repeat resets the specific days.
                            </p>
                        )}
                    </div>
                )}

                {error && <p className="modal-error">{error}</p>}

                <div className="modal-actions">
                    <button type="button" className="btn btn-quiet btn-quiet-danger modal-delete" onClick={onDelete}>
                        Delete
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={close}>
                        Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={!content.trim() || busy}>
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
