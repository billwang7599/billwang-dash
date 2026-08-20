import { useEffect, useRef, useState } from "react";
import type { Project, Recurrence, Task } from "../../shared/types.ts";
import { formatRecurrence } from "../format.ts";

interface Props {
  task: Task;
  projects: Project[];
  timeZone: string;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

const FREQS = ["daily", "weekly", "monthly", "yearly"] as const;

export function TaskModal({ task, projects, timeZone, onSave, onClose }: Props) {
  const [content, setContent] = useState(task.content);
  const [description, setDescription] = useState(task.description);
  const [projectId, setProjectId] = useState(task.projectId);
  const [priority, setPriority] = useState(String(task.priority));
  const [dueDate, setDueDate] = useState(task.due?.date ?? "");
  const [dueTime, setDueTime] = useState(task.due?.time ?? "");
  const [deadline, setDeadline] = useState(task.deadline ?? "");
  const [duration, setDuration] = useState(
    task.durationMinutes === null ? "" : String(task.durationMinutes),
  );
  const [labels, setLabels] = useState(task.labels.join(", "));
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
        priority: Number(priority),
        labels: labels.split(",").map((l) => l.trim()).filter(Boolean),
        deadline: deadline || null,
        durationMinutes: duration ? Number(duration) : null,
        due: dueDate
          ? {
              date: dueDate,
              time: dueTime || null,
              recurrence: buildRecurrence(),
              timeZone: task.due?.timeZone ?? timeZone,
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
              <span>Project</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="1">P1 — Urgent</option>
                <option value="2">P2 — High</option>
                <option value="3">P3 — Medium</option>
                <option value="4">P4 — Normal</option>
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
              <span>Repeat</span>
              <select value={freq} onChange={(e) => setFreq(e.target.value)} disabled={!dueDate}>
                <option value="none">Never</option>
                {FREQS.map((f) => (
                  <option key={f} value={f}>
                    {f[0].toUpperCase() + f.slice(1)}
                  </option>
                ))}
              </select>
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

            <label className="modal-wide">
              <span>Labels</span>
              <input
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="comma, separated"
              />
            </label>
          </div>

          {original && original.weekdays.length > 0 && freq === original.freq && (
            <p className="modal-note">
              Keeping “{formatRecurrence(original)}”. Changing Repeat resets the specific days.
            </p>
          )}

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
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
