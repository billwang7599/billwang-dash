import { useEffect, useRef, useState } from "react";
import { civilFromKey, diffDays } from "../../shared/civil.ts";
import type { Goal } from "../../shared/goals.ts";
import type { Project, Task } from "../../shared/types.ts";
import { formatDateLabel, formatRecurrence, formatTime, priorityName } from "../format.ts";
import { playDone } from "../sounds.ts";

/**
 * - inbox: date groups, each split into one colour card per project.
 * - project: one card per date group, all in the project's colour.
 * - flat: plain rows, no cards (a goal's steps).
 *
 * In both card layouts a card's colour fades the further away its date is, so the
 * hue says which project and the strength says how soon. Dates past LATER_DAYS fold
 * into one plain "Later" card until it's opened.
 */
type Layout = "inbox" | "project" | "flat";

const LATER_DAYS = 14;

interface Props {
    tasks: Task[];
    projects: Project[];
    /** When given, a step shows which goal it's toward. Left out on the goal's own card. */
    goals?: Goal[];
    timeZone: string;
    /** Today in the user's zone, YYYY-MM-DD; earlier due dates fold into one Overdue group. */
    today: string;
    layout: Layout;
    /** Project id -> card colour, from projectColors. */
    colors?: Map<string, string>;
    emptyMessage: string;
    onComplete: (id: string) => void;
    onDelete: (id: string) => void;
    onOpen: (task: Task) => void;
    /** Project card headings and #project labels link to the project's page. */
    onOpenProject?: (id: string) => void;
    /** ◎ goal labels link to the Goals page. */
    onOpenGoal?: (id: string) => void;
}

export function TaskList({
    tasks,
    projects,
    goals,
    timeZone,
    today,
    layout,
    colors,
    emptyMessage,
    onComplete,
    onDelete,
    onOpen,
    onOpenProject,
    onOpenGoal,
}: Props) {
    // Not persisted: Later starts folded each visit.
    const [laterOpen, setLaterOpen] = useState(false);

    if (tasks.length === 0) {
        return (
            <div className="empty">
                <p>{emptyMessage}</p>
            </div>
        );
    }

    const projectOf = (id: string) => projects.find((p) => p.id === id) ?? null;
    const goalFor = (id: string | null) => (id && goals?.find((g) => g.id === id)) || null;
    const row = (task: Task, inGroup: string | null) => (
        <TaskRow
            key={task.id}
            task={task}
            project={layout === "flat" ? projectOf(task.projectId) : null}
            goal={goalFor(task.goalId)}
            timeZone={timeZone}
            group={inGroup}
            onComplete={onComplete}
            onDelete={onDelete}
            onOpen={onOpen}
            onOpenProject={onOpenProject}
            onOpenGoal={onOpenGoal}
        />
    );

    if (layout === "flat") {
        return <ul className="tasks">{undatedFirst(tasks).map((t) => row(t, null))}</ul>;
    }

    const groups = groupTasks(tasks, today);
    const isLater = (key: string) => daysAway(key, today) > LATER_DAYS;
    const near = groups.filter(([key]) => !isLater(key));
    const later = groups.filter(([key]) => isLater(key));
    const strength = (key: string) => ({ ["--strength" as string]: `${cardStrength(key, today)}%` });

    // Everything past the cut-off, as one plain card until opened.
    const laterCard = later.length > 0 && !laterOpen && (
        <LaterCard
            groups={later}
            colors={colors}
            timeZone={timeZone}
            showProject={layout === "inbox"}
            onOpen={() => setLaterOpen(true)}
        />
    );
    const shown = laterOpen ? groups : near;

    if (layout === "project") {
        const color = colors?.get(tasks[0].projectId);
        return (
            <>
                <div className="stack" style={color ? { ["--card-c" as string]: color } : undefined}>
                    {shown.map(([key, groupTasks]) => (
                        <section className="tcard" key={key} style={strength(key)}>
                            <h3 className="tcard-head">
                                {groupLabel(key, timeZone)}
                                <span>{groupTasks.length}</span>
                            </h3>
                            <ul className="tasks">{groupTasks.map((t) => row(t, key))}</ul>
                        </section>
                    ))}
                </div>
                {laterCard}
            </>
        );
    }

    // Inbox: project cards follow the sidebar's project order, so they don't shuffle day to day.
    const projectOrder = new Map([...(colors?.keys() ?? [])].map((id, i) => [id, i]));
    return (
        <div className="task-groups">
            {shown.map(([key, groupTasks]) => {
                const byProject = new Map<string, Task[]>();
                for (const t of groupTasks) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t]);
                const cards = [...byProject.entries()].sort(
                    ([a], [b]) => (projectOrder.get(a) ?? 0) - (projectOrder.get(b) ?? 0),
                );
                return (
                    <section className="task-group" key={key}>
                        <h3 className="group-head">
                            {groupLabel(key, timeZone)}
                            <span className="group-count">{groupTasks.length}</span>
                        </h3>
                        <div className="stack">
                            {cards.map(([projectId, cardTasks]) => (
                                <div
                                    className="tcard"
                                    key={projectId}
                                    style={{ ["--card-c" as string]: colors?.get(projectId), ...strength(key) }}
                                >
                                    <h4 className="tcard-head">
                                        {onOpenProject ? (
                                            <button className="tcard-link" onClick={() => onOpenProject(projectId)}>
                                                {projectOf(projectId)?.name ?? "Unknown project"}
                                            </button>
                                        ) : (
                                            (projectOf(projectId)?.name ?? "Unknown project")
                                        )}
                                        <span>{cardTasks.length}</span>
                                    </h4>
                                    <ul className="tasks">{cardTasks.map((t) => row(t, key))}</ul>
                                </div>
                            ))}
                        </div>
                    </section>
                );
            })}
            {laterCard && <section className="task-group">{laterCard}</section>}
        </div>
    );
}

/**
 * Ticking a task off: the circle fills and pops, a line sweeps through the title, a
 * chime plays, then the row folds away and only then is the task completed, so the
 * list doesn't jump before you've seen it happen. If it's still here a while later
 * (the save failed), the row comes back.
 */
function useCompleteAnimation(id: string, recurring: boolean, onComplete: (id: string) => void) {
    const [completing, setCompleting] = useState(false);
    const rowRef = useRef<HTMLLIElement>(null);
    const timers = useRef<number[]>([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    function complete() {
        if (completing) return;
        setCompleting(true);
        playDone();
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const row = rowRef.current;
        const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));

        // Fold the row from its real height, which varies with wrapping and chips.
        later(reduced ? 0 : 380, () => {
            if (!row) return;
            row.style.height = `${row.offsetHeight}px`;
            requestAnimationFrame(() => {
                row.style.height = "0px";
                row.classList.add("is-folding");
            });
        });
        later(reduced ? 0 : 640, () => onComplete(id));
        // A repeating task comes straight back with its next date, and a failed save
        // leaves it where it was: either way, unfold it.
        later(recurring ? 1100 : 4000, () => {
            row?.classList.remove("is-folding");
            row?.style.removeProperty("height");
            setCompleting(false);
        });
    }

    return { completing, rowRef, complete };
}

/** A meta label that's a link when there's somewhere to go, plain text otherwise. */
function MetaLink({ className, onClick, children }: { className: string; onClick?: () => void; children: React.ReactNode }) {
    return onClick ? (
        <button className={`${className} meta-link`} onClick={onClick}>
            {children}
        </button>
    ) : (
        <span className={className}>{children}</span>
    );
}

/** The folded tail: a count and a peek at the next few tasks. Opening it shows the rest as cards. */
function LaterCard({
    groups,
    colors,
    timeZone,
    showProject,
    onOpen,
}: {
    groups: [string, Task[]][];
    colors?: Map<string, string>;
    timeZone: string;
    /** Inbox mixes projects, so each peeked task gets its project's dot. */
    showProject: boolean;
    onOpen: () => void;
}) {
    const all = groups.flatMap(([, ts]) => ts);
    const peek = all.slice(0, 3);
    return (
        <button className="later-card" onClick={onOpen} aria-label={`Show ${all.length} later tasks`}>
            <span className="tcard-head">
                Later
                <span>{all.length}</span>
            </span>
            <span className="later-peek">
                {peek.map((t) => (
                    <span key={t.id} className="later-item">
                        {showProject && (
                            <span
                                className="nav-swatch"
                                style={{ background: colors?.get(t.projectId) }}
                                aria-hidden="true"
                            />
                        )}
                        {t.content} · {formatDateLabel(t.due!.date, timeZone)}
                    </span>
                ))}
                {all.length > peek.length && <span className="later-item">and {all.length - peek.length} more</span>}
            </span>
        </button>
    );
}

function TaskRow({
    task,
    project,
    goal,
    timeZone,
    group,
    onComplete,
    onDelete,
    onOpen,
    onOpenProject,
    onOpenGoal,
}: {
    task: Task;
    /** Shown only where the row isn't already inside its project's card. */
    project: Project | null;
    goal: Goal | null;
    timeZone: string;
    /** The date group the row sits in, which decides what the right-hand label says. */
    group: string | null;
    onComplete: (id: string) => void;
    onDelete: (id: string) => void;
    onOpen: (task: Task) => void;
    onOpenProject?: (id: string) => void;
    onOpenGoal?: (id: string) => void;
}) {
    const due = task.due;
    // Inside a single-date group the date is the heading, so only the time is left to say.
    // Overdue and ungrouped rows still need their date.
    const { completing, rowRef, complete } = useCompleteAnimation(task.id, Boolean(task.due?.recurrence), onComplete);
    const when = !due
        ? null
        : group === due.date
          ? due.time && formatTime(due.time)
          : [formatDateLabel(due.date, timeZone), due.time && formatTime(due.time)].filter(Boolean).join(" ");

    return (
        <li ref={rowRef} className={`task${task.completed ? " is-done" : ""}${completing ? " is-completing" : ""}`}>
            <button
                className="check"
                data-p={task.priority}
                onClick={complete}
                aria-label={`Complete ${task.content}`}
                title={priorityName(task.priority)}
            >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
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

            {/* The project and goal labels are links of their own, so they sit beside the
                edit button rather than inside it (a button can't hold another). */}
            <div className="task-main">
                <button className="task-body" onClick={() => onOpen(task)} aria-label={`Edit ${task.content}`}>
                    <p className="task-title">{task.content}</p>
                    {(due?.recurrence || task.deadline) && (
                        <div className="task-chips">
                            {due?.recurrence && <span className="chip">{formatRecurrence(due.recurrence)}</span>}
                            {task.deadline && <span className="chip chip-deadline">deadline {task.deadline}</span>}
                        </div>
                    )}
                </button>
                {(goal || (project && !project.isInbox)) && (
                    <div className="task-meta">
                        {project && !project.isInbox && (
                            <MetaLink className="meta-project" onClick={onOpenProject && (() => onOpenProject(project.id))}>
                                #{project.name}
                            </MetaLink>
                        )}
                        {goal && (
                            <MetaLink className="meta-goal" onClick={onOpenGoal && (() => onOpenGoal(goal.id))}>
                                ◎ {goal.title}
                            </MetaLink>
                        )}
                    </div>
                )}
            </div>

            {when && <span className={`task-when${group === "overdue" ? " is-late" : ""}`}>{when}</span>}

            <button
                className="task-delete"
                onClick={() => onDelete(task.id)}
                aria-label={`Delete ${task.content}`}
            >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path
                        d="M4 4l8 8M12 4l-8 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
        </li>
    );
}

/** Days from today to a group's date; undated and overdue count as now. */
function daysAway(key: string, today: string): number {
    if (key === "none" || key === "overdue") return 0;
    return diffDays(civilFromKey(today)!, civilFromKey(key)!);
}

/**
 * How strong a group's colour is, in percent: full for overdue and today, about 5%
 * weaker each day after, never below 35% so the project still reads. Undated tasks
 * aren't urgent, so they sit at a middling 60%.
 */
function cardStrength(key: string, today: string): number {
    if (key === "none") return 60;
    return Math.max(35, 100 - daysAway(key, today) * 5);
}

function groupLabel(key: string, timeZone: string): string {
    if (key === "none") return "No date";
    if (key === "overdue") return "Overdue";
    return formatDateLabel(key, timeZone);
}

/**
 * Undated tasks go on top, so they aren't buried under everything scheduled.
 * Stable, so the server's order holds within each part.
 */
function undatedFirst(tasks: Task[]): Task[] {
    return [...tasks.filter((t) => !t.due), ...tasks.filter((t) => t.due)];
}

/** Buckets by due date: undated first, then everything overdue as one group, then each day in order. */
function groupTasks(tasks: Task[], today: string): [string, Task[]][] {
    const buckets = new Map<string, Task[]>();
    for (const task of tasks) {
        const key = !task.due ? "none" : task.due.date < today ? "overdue" : task.due.date;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(task);
        else buckets.set(key, [task]);
    }

    const rank = (k: string) => (k === "none" ? 0 : k === "overdue" ? 1 : 2);
    return [...buckets.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}
