import { useEffect, useState } from "react";
import {
    daysLeft,
    HORIZON_HINTS,
    HORIZON_LABELS,
    HORIZONS,
    isDone,
    progress,
    type Goal,
    type GoalInput,
    type Horizon,
} from "../../shared/goals.ts";
import { formatPlainDate } from "../format.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { GoalModal, numeric } from "./GoalModal.tsx";

interface Props {
    goals: Goal[];
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    onCreate: (input: GoalInput) => Promise<void>;
    onUpdate: (id: string, input: GoalInput) => Promise<void>;
    onProgress: (id: string, current: number) => void;
    onDelete: (id: string) => void;
}

/** The modal is either editing a goal or adding one under a horizon. */
type Editing = { goal: Goal } | { horizon: Horizon } | null;

export function GoalsView({ goals, today, onCreate, onUpdate, onProgress, onDelete }: Props) {
    const [editing, setEditing] = useState<Editing>(null);
    const [deleting, setDeleting] = useState<Goal | null>(null);

    return (
        <div className="goals-view">
            <h1 className="view-title">Goals</h1>

            {HORIZONS.map((h) => {
                const inHorizon = goals.filter((g) => g.horizon === h);
                const active = inHorizon.filter((g) => !isDone(g));
                const done = inHorizon.filter(isDone);
                return (
                    <section key={h} className="goal-section" aria-label={HORIZON_LABELS[h]}>
                        <div className="goal-section-head">
                            <h2>
                                {HORIZON_LABELS[h]} <span className="goal-section-hint">{HORIZON_HINTS[h]}</span>
                            </h2>
                            <button className="sort-toggle" onClick={() => setEditing({ horizon: h })}>
                                + Add
                            </button>
                        </div>

                        {active.map((g) => (
                            <GoalCard
                                key={g.id}
                                goal={g}
                                today={today}
                                onProgress={onProgress}
                                onEdit={() => setEditing({ goal: g })}
                                onDelete={() => setDeleting(g)}
                            />
                        ))}
                        {active.length === 0 && <p className="habit-empty goal-empty">No open goals here.</p>}

                        {done.length > 0 && (
                            <details className="goal-done">
                                <summary>Completed ({done.length})</summary>
                                {done.map((g) => (
                                    <GoalCard
                                        key={g.id}
                                        goal={g}
                                        today={today}
                                        onProgress={onProgress}
                                        onEdit={() => setEditing({ goal: g })}
                                        onDelete={() => setDeleting(g)}
                                    />
                                ))}
                            </details>
                        )}
                    </section>
                );
            })}

            {editing && (
                <GoalModal
                    goal={"goal" in editing ? editing.goal : undefined}
                    horizon={"horizon" in editing ? editing.horizon : undefined}
                    today={today}
                    onSave={(input) => ("goal" in editing ? onUpdate(editing.goal.id, input) : onCreate(input))}
                    onClose={() => setEditing(null)}
                />
            )}

            {deleting && (
                <ConfirmDialog
                    title="Delete goal?"
                    message={`"${deleting.title}" will be deleted for good.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        onDelete(deleting.id);
                        setDeleting(null);
                    }}
                    onCancel={() => setDeleting(null)}
                />
            )}
        </div>
    );
}

function GoalCard({
    goal,
    today,
    onProgress,
    onEdit,
    onDelete,
}: {
    goal: Goal;
    today: string;
    onProgress: (id: string, current: number) => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    // Typed edits stay local until Enter or blur, so each keystroke isn't a request.
    const [draft, setDraft] = useState(String(goal.current));
    useEffect(() => setDraft(String(goal.current)), [goal.current]);

    const commit = () => {
        const n = Number(draft);
        if (draft.trim() === "" || !Number.isFinite(n) || n < 0) return setDraft(String(goal.current));
        if (n !== goal.current) onProgress(goal.id, n);
    };

    const done = isDone(goal);
    const yesNo = goal.target === null;
    const left = daysLeft(today, goal.deadline);
    const due = done
        ? "Done"
        : left > 0
          ? `${left} day${left === 1 ? "" : "s"} left`
          : left === 0
            ? "Due today"
            : `${-left} day${left === -1 ? "" : "s"} overdue`;

    return (
        <article className={`goal-card${done ? " is-done" : ""}${yesNo ? " is-yesno" : ""}`}>
            <div className="goal-card-head">
                {yesNo && (
                    <button
                        className={`habit-check goal-check${done ? " is-done" : ""}`}
                        onClick={() => onProgress(goal.id, done ? 0 : 1)}
                        aria-label={`${done ? "Undo" : "Mark done"}: ${goal.title}`}
                        aria-pressed={done}
                    >
                        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                            <path
                                d="M2.5 8.5l3.5 3.5 7.5-8"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </button>
                )}
                <h3>{goal.title}</h3>
                <div className="goal-card-actions">
                    <button className="sort-toggle" onClick={onEdit}>
                        Edit
                    </button>
                    <button className="sort-toggle" onClick={onDelete}>
                        Delete
                    </button>
                </div>
            </div>
            {goal.why && <p className="goal-why">{goal.why}</p>}

            {goal.target !== null && (
                <div
                    className="goal-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={goal.target}
                    aria-valuenow={goal.current}
                    aria-label={`${goal.title} progress`}
                >
                    <span style={{ width: `${progress(goal) * 100}%` }} />
                </div>
            )}

            <div className="goal-card-foot">
                {!yesNo && (
                    <div className="goal-stepper" role="group" aria-label="Progress">
                        <button
                            className="habit-step"
                            onClick={() => onProgress(goal.id, Math.max(0, goal.current - 1))}
                            disabled={goal.current <= 0}
                            aria-label="One less"
                        >
                            −
                        </button>
                        <input
                            className="goal-current"
                            inputMode="decimal"
                            value={draft}
                            onChange={(e) => setDraft(numeric(e.target.value))}
                            onBlur={commit}
                            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            aria-label="Progress so far"
                        />
                        <span className="goal-of">
                            / {goal.target}
                            {goal.unit && ` ${goal.unit}`}
                        </span>
                        <button
                            className="habit-step"
                            onClick={() => onProgress(goal.id, goal.current + 1)}
                            aria-label="One more"
                        >
                            +
                        </button>
                    </div>
                )}
                <p className={`goal-due${!done && left < 0 ? " is-overdue" : ""}`}>
                    {formatPlainDate(goal.deadline)} · {due}
                </p>
            </div>
        </article>
    );
}
