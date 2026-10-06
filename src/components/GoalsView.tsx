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
import type { Project, Task } from "../../shared/types.ts";
import { formatPlainDate } from "../format.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { GoalModal, numeric } from "./GoalModal.tsx";
import { TaskList } from "./TaskList.tsx";

interface Props {
    goals: Goal[];
    /** Open tasks; the ones with a goalId are that goal's steps. */
    tasks: Task[];
    projects: Project[];
    timeZone: string;
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    onCreate: (input: GoalInput) => Promise<void>;
    onUpdate: (id: string, input: GoalInput) => Promise<void>;
    onProgress: (id: string, current: number) => void;
    onDelete: (id: string) => void;
    /** Quick-add text, so "tomorrow" or "#project" work as they do in the Inbox. */
    onAddStep: (goalId: string, text: string) => Promise<void>;
    onCompleteTask: (id: string) => void;
    onDeleteTask: (id: string) => void;
    onOpenTask: (task: Task) => void;
}

/** What a card needs to show and manage its steps. */
type StepProps = Pick<
    Props,
    "projects" | "timeZone" | "onAddStep" | "onCompleteTask" | "onDeleteTask" | "onOpenTask"
>;

/** The modal is either editing a goal or adding one under a horizon. */
type Editing = { goal: Goal } | { horizon: Horizon } | null;

export function GoalsView({
    goals,
    tasks,
    projects,
    timeZone,
    today,
    onCreate,
    onUpdate,
    onProgress,
    onDelete,
    onAddStep,
    onCompleteTask,
    onDeleteTask,
    onOpenTask,
}: Props) {
    const stepProps: StepProps = { projects, timeZone, onAddStep, onCompleteTask, onDeleteTask, onOpenTask };
    const stepsOf = (goalId: string) => tasks.filter((t) => t.goalId === goalId);
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
                                steps={stepsOf(g.id)}
                                stepProps={stepProps}
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
                                        steps={stepsOf(g.id)}
                                        stepProps={stepProps}
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
    steps,
    stepProps,
    onProgress,
    onEdit,
    onDelete,
}: {
    goal: Goal;
    today: string;
    steps: Task[];
    stepProps: StepProps;
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

            <GoalSteps goalId={goal.id} steps={steps} stepsDone={goal.stepsDone} {...stepProps} />
        </article>
    );
}

/**
 * A goal's open tasks, as a mini to-do list, plus a quick-add line for new ones.
 * Steps are ordinary tasks, so they also show in the Inbox; ticking one off
 * doesn't move the goal's progress, which measures the outcome, not the work.
 */
function GoalSteps({
    goalId,
    steps,
    stepsDone,
    projects,
    timeZone,
    onAddStep,
    onCompleteTask,
    onDeleteTask,
    onOpenTask,
}: StepProps & { goalId: string; steps: Task[]; stepsDone: number }) {
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function add(e: React.FormEvent) {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            await onAddStep(goalId, text.trim());
            setText("");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="goal-steps">
            {stepsDone > 0 && (
                <p className="goal-steps-done">
                    {stepsDone} step{stepsDone === 1 ? "" : "s"} done
                </p>
            )}
            {steps.length > 0 && (
                <TaskList
                    tasks={steps}
                    projects={projects}
                    timeZone={timeZone}
                    groupByDate={false}
                    emptyMessage=""
                    onComplete={onCompleteTask}
                    onDelete={onDeleteTask}
                    onOpen={onOpenTask}
                />
            )}
            <form className="goal-step-add" onSubmit={add}>
                <span aria-hidden="true">+</span>
                <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={steps.length ? "Add a step" : "Add a first step, e.g. Buy the book tomorrow"}
                    aria-label="Add a step"
                    disabled={busy}
                />
            </form>
            {error && <p className="modal-error">{error}</p>}
        </div>
    );
}
