import { useEffect, useRef, useState } from "react";
import { isDone, type Goal } from "../../shared/goals.ts";
import type { Project, Recurrence, Task } from "../../shared/types.ts";
import { formatRecurrence } from "../format.ts";

interface Props {
    task: Task;
    projects: Project[];
    goals: Goal[];
    /** Project id -> card colour; the band at the top takes the chosen project's. */
    colors: Map<string, string>;
    onSave: (patch: Record<string, unknown>) => Promise<void>;
    /** Hands over to the delete confirmation. */
    onDelete: () => void;
    onClose: () => void;
}

const FREQS = ["daily", "weekly", "monthly", "yearly"] as const;
const PRIORITIES = [
    ["1", "Urgent"],
    ["2", "High"],
    ["3", "Medium"],
    ["4", "Normal"],
] as const;

export function TaskModal({ task, projects, goals, colors, onSave, onDelete, onClose }: Props) {
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

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const titleRef = useRef<HTMLInputElement>(null);

    useEffect(() => titleRef.current?.focus(), []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const original = task.due?.recurrence ?? null;

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
            onClose();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <div className="modal-backdrop" onMouseDown={onClose}>
            <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label="Edit task"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <form onSubmit={save}>
                    {/* Where the task lives, in that project's colour; the select is how you move it. */}
                    <label className="modal-band" style={{ ["--card-c" as string]: colors.get(projectId) }}>
                        <span className="nav-swatch" aria-hidden="true" />
                        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                            {projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
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

                    <div className="modal-grid">
                        <label>
                            <span>Goal</span>
                            <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
                                <option value="">None</option>
                                {/* Finished goals stay out of the way, unless this task is already on one. */}
                                {goals
                                    .filter((g) => !isDone(g) || g.id === task.goalId)
                                    .map((g) => (
                                        <option key={g.id} value={g.id}>
                                            {g.title}
                                        </option>
                                    ))}
                            </select>
                        </label>

                        <label>
                            <span>Due date</span>
                            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                        </label>

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
                            <span>Every</span>
                            <input
                                type="number"
                                min={1}
                                value={interval}
                                onChange={(e) => setInterval(e.target.value)}
                                disabled={freq === "none"}
                            />
                        </label>

                        <label>
                            <span>Deadline</span>
                            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
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

                    <div className="modal-pills" role="radiogroup" aria-label="Repeat">
                        <span>Repeat</span>
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
                    </div>

                    {original && original.weekdays.length > 0 && freq === original.freq && (
                        <p className="modal-note">
                            Keeping “{formatRecurrence(original)}”. Changing Repeat resets the specific days.
                        </p>
                    )}

                    {error && <p className="modal-error">{error}</p>}

                    <div className="modal-actions">
                        <button type="button" className="btn btn-quiet btn-quiet-danger modal-delete" onClick={onDelete}>
                            Delete
                        </button>
                        <button type="button" className="btn btn-quiet" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={!content.trim() || busy}>
                            {busy ? "Saving…" : "Save"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
