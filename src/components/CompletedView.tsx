import { useCallback, useEffect, useState } from "react";
import { addDays, civilFromDate, civilFromKey, civilKey, weekday } from "../../shared/civil.ts";
import type { Goal } from "../../shared/goals.ts";
import type { Project, Task } from "../../shared/types.ts";
import { api } from "../api.ts";
import { formatInstant, formatPlainDate } from "../format.ts";
import { Hero } from "./Hero.tsx";

interface Props {
    projects: Project[];
    goals: Goal[];
    timeZone: string;
    /** Project id -> card colour, shown as a dot on each row. */
    colors: Map<string, string>;
    /** When given, only this project's tasks, and Back returns to it. */
    project?: Project;
    /** Done since Monday, from the app state (this project's, when there is one). */
    doneThisWeek: number;
    /** Puts the task back on the list; the app reloads its own state. */
    onUndo: (task: Task) => Promise<void>;
    onBack: () => void;
}

/** Completed tasks, newest first, grouped by the day they were finished, a page at a time. */
export function CompletedView({ projects, goals, timeZone, colors, project, doneThisWeek, onUndo, onBack }: Props) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [more, setMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const projectId = project?.id;
    const load = useCallback(async (before?: string) => {
        setLoading(true);
        setError(null);
        try {
            const page = await api.listCompleted(before, projectId);
            setTasks((prev) => (before ? [...prev, ...page.tasks] : page.tasks));
            setMore(page.more);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    async function undo(task: Task) {
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
        await onUndo(task);
    }

    const today = civilFromDate(new Date(), timeZone);
    const dayLabel = (key: string) => {
        if (key === civilKey(today)) return "Today";
        if (key === civilKey(addDays(today, -1))) return "Yesterday";
        return civilFromKey(key) ? formatPlainDate(key) : key;
    };

    // Grouped by the day finished, in the user's zone; the list is already newest first.
    const groups: [string, Task[]][] = [];
    for (const t of tasks) {
        const key = t.completedAt ? civilKey(civilFromDate(new Date(t.completedAt), timeZone)) : "";
        const last = groups[groups.length - 1];
        if (last && last[0] === key) last[1].push(t);
        else groups.push([key, [t]]);
    }

    // Weeks run Monday-first, like the server's count.
    const daysThisWeek = ((weekday(today) + 6) % 7) + 1;
    const doneToday = groups.find(([key]) => key === civilKey(today))?.[1].length ?? 0;

    return (
        <div className="completed-view">
            <div className="view-bar is-start">
                <button className="back-link" onClick={onBack}>
                    ← {project ? project.name : "Inbox"}
                </button>
            </div>
            <Hero
                kicker={project ? `Done this week in ${project.name}` : "Done this week"}
                title={doneThisWeek}
                stats={[
                    { value: doneToday, label: "today" },
                    { value: (doneThisWeek / daysThisWeek).toFixed(1), label: "a day" },
                ]}
            />

            {error && <p className="banner banner-bad">{error}</p>}
            {!loading && tasks.length === 0 && !error && (
                <div className="empty">
                    <p>Nothing completed yet.</p>
                </div>
            )}

            <div className="task-groups">
                {groups.map(([key, group]) => (
                    <section className="task-group" key={key}>
                        <h3 className="group-head">
                            {dayLabel(key)}
                            <span className="group-count">{group.length}</span>
                        </h3>
                        <ul className="tasks log-card">
                            {group.map((t) => {
                                const project = projects.find((p) => p.id === t.projectId);
                                const goal = t.goalId ? goals.find((g) => g.id === t.goalId) : undefined;
                                return (
                                    <li key={t.id} className="task is-done">
                                        <button
                                            className="check is-checked"
                                            onClick={() => undo(t)}
                                            aria-label={`Undo completing ${t.content}`}
                                            title="Undo: put it back"
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
                                        <div className="task-body">
                                            <p className="task-title">{t.content}</p>
                                            <div className="task-meta">
                                                <span
                                                    className="nav-swatch"
                                                    style={{ background: colors.get(t.projectId) }}
                                                    aria-hidden="true"
                                                />
                                                {t.completedAt && (
                                                    <span className="meta-due">{formatInstant(t.completedAt, timeZone)}</span>
                                                )}
                                                {project && !project.isInbox && (
                                                    <span className="meta-project">#{project.name}</span>
                                                )}
                                                {goal && <span className="meta-goal">◎ {goal.title}</span>}
                                            </div>
                                        </div>
                                        <button className="sort-toggle completed-undo" onClick={() => undo(t)}>
                                            Undo
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ))}
            </div>

            {more && (
                <button
                    className="btn btn-quiet completed-more"
                    disabled={loading}
                    onClick={() => load(tasks[tasks.length - 1]?.completedAt ?? undefined)}
                >
                    {loading ? "Loading…" : "Load more"}
                </button>
            )}
        </div>
    );
}
