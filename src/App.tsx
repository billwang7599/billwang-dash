import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Goal, GoalInput } from "../shared/goals.ts";
import type { HabitInput, HabitSummary } from "../shared/habits.ts";
import type { Task } from "../shared/types.ts";
import { api, type AppState, type Preferences } from "./api.ts";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { GoalsView } from "./components/GoalsView.tsx";
import { HabitModal } from "./components/HabitModal.tsx";
import { HabitView } from "./components/HabitView.tsx";
import { ImportModal } from "./components/ImportModal.tsx";
import { ProjectFilter } from "./components/ProjectFilter.tsx";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TimeZoneNotice } from "./components/TimeZoneNotice.tsx";
import { Trash } from "./components/Trash.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { TaskModal } from "./components/TaskModal.tsx";
import { WeekCalendar } from "./components/WeekCalendar.tsx";
import { deviceTimeZone, todayKey } from "./format.ts";

export type View =
    | { name: "inbox" }
    | { name: "calendar" }
    | { name: "settings" }
    | { name: "trash" }
    | { name: "goals" }
    | { name: "habit"; id: string }
    | { name: "project"; id: string };

function viewFromPath(pathname: string): View {
    const rest = pathname.replace(/^\/app\/?/, "").replace(/\/$/, "");
    if (rest.startsWith("project/")) return { name: "project", id: rest.slice(8) };
    if (rest === "calendar") return { name: "calendar" };
    if (rest === "settings") return { name: "settings" };
    if (rest === "trash") return { name: "trash" };
    if (rest === "goals") return { name: "goals" };
    if (rest.startsWith("habit/")) return { name: "habit", id: rest.slice(6) };
    // Old bookmarks to /app or /app/upcoming land here too; Inbox is the home view.
    return { name: "inbox" };
}

export function App() {
    const [state, setState] = useState<AppState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [editing, setEditing] = useState<Task | null>(null);
    const [newHabit, setNewHabit] = useState(false);
    // Bumped when a habit changes outside the habit page, so its month reloads.
    const [habitRevision, setHabitRevision] = useState(0);
    const [pendingTaskDelete, setPendingTaskDelete] = useState<Task | null>(null);
    // Set when several lines are pasted into the quick-add bar; opens the import modal.
    const [importText, setImportText] = useState<string | null>(null);
    const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
    // Calendar data lives server-side; bump this to make it refetch after edits.
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        api.getState().then(setState).catch((e: Error) => setError(e.message));
    }, []);

    useEffect(() => {
        const onPop = () => setView(viewFromPath(window.location.pathname));
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    // A brand-new account defaults to UTC; adopt the browser's zone once, quietly.
    const triedAutoZone = useRef(false);
    useEffect(() => {
        if (!state || state.preferences.timeZoneSet || triedAutoZone.current) return;
        triedAutoZone.current = true;
        api.setPreferences({ timeZone: deviceTimeZone() })
            .then(({ preferences }) => {
                setState((prev) => (prev ? { ...prev, preferences } : prev));
                setRevision((r) => r + 1);
            })
            .catch(() => {}); // best effort: Settings still lets the user pick
    }, [state]);

    const navigate = useCallback((path: string) => {
        window.history.pushState({}, "", path);
        setView(viewFromPath(path));
    }, []);

    /**
     * Wraps a mutation so a failure surfaces instead of becoming an unhandled
     * rejection. Without this a failed complete/delete silently does nothing and
     * the row just appears unresponsive.
     */
    const run = useCallback(
        (fn: () => Promise<void>) => () =>
            fn()
                .then(() => setNotice(null))
                .catch((e: Error) => setNotice(e.message)),
        [],
    );

    const addTask = useCallback(
        async (text: string) => {
            if (!state) return;
            await api.createTask(text, state.preferences.timeZone);
            // Refetch rather than splice: a "#name" token may have created a project
            // server-side, so the sidebar can be stale too.
            setState(await api.getState());
            setRevision((r) => r + 1);
        },
        [state],
    );

    const completeTask = useCallback(
        (id: string) =>
            run(async () => {
                const { task } = await api.completeTask(id);
                setState((prev) =>
                    prev
                        ? {
                                ...prev,
                                // A recurring task comes back rescheduled, not completed.
                                tasks: task.completed
                                    ? prev.tasks.filter((t) => t.id !== id)
                                    : prev.tasks.map((t) => (t.id === id ? task : t)),
                            }
                        : prev,
                );
                setRevision((r) => r + 1);
            })(),
        [run],
    );

    const deleteTask = useCallback(
        (id: string) =>
            run(async () => {
                await api.deleteTask(id);
                setState((prev) =>
                    prev ? { ...prev, tasks: prev.tasks.filter((t) => t.id !== id) } : prev,
                );
                setRevision((r) => r + 1);
            })(),
        [run],
    );

    /** After the trash restores something, projects and tasks may both have changed. */
    const reload = useCallback(async () => {
        setState(await api.getState());
        setRevision((r) => r + 1);
    }, []);

    /** Puts a habit the server just returned into the list, adding it if it's new. */
    const applyHabit = useCallback((habit: HabitSummary) => {
        setState((prev) => {
            if (!prev) return prev;
            const exists = prev.habits.some((h) => h.id === habit.id);
            return {
                ...prev,
                habits: exists ? prev.habits.map((h) => (h.id === habit.id ? habit : h)) : [...prev.habits, habit],
            };
        });
    }, []);

    const checkHabitToday = useCallback(
        (habit: HabitSummary) =>
            run(async () => {
                if (!state) return;
                const { habit: updated } = await api.setCheckin(
                    habit.id,
                    todayKey(state.preferences.timeZone),
                    habit.today === "done" ? null : "done",
                );
                applyHabit(updated);
                setHabitRevision((r) => r + 1);
            })(),
        [run, state, applyHabit],
    );

    const createHabit = useCallback(
        async (input: HabitInput) => {
            const { habit } = await api.createHabit(input);
            applyHabit(habit);
            navigate(`/app/habit/${habit.id}`);
        },
        [applyHabit, navigate],
    );

    const updateHabit = useCallback(
        async (id: string, input: HabitInput) => {
            const { habit } = await api.updateHabit(id, input);
            applyHabit(habit);
            setHabitRevision((r) => r + 1);
        },
        [applyHabit],
    );

    const deleteHabit = useCallback(
        (id: string) =>
            run(async () => {
                await api.deleteHabit(id);
                setState((prev) => (prev ? { ...prev, habits: prev.habits.filter((h) => h.id !== id) } : prev));
                navigate("/app");
            })(),
        [run, navigate],
    );

    /** Puts a goal the server just returned into the list, adding it if it's new. */
    const applyGoal = useCallback((goal: Goal) => {
        setState((prev) => {
            if (!prev) return prev;
            const exists = prev.goals.some((g) => g.id === goal.id);
            const goals = exists ? prev.goals.map((g) => (g.id === goal.id ? goal : g)) : [...prev.goals, goal];
            // Same order as the server: soonest deadline first.
            return { ...prev, goals: goals.sort((a, b) => a.deadline.localeCompare(b.deadline) || a.sortOrder - b.sortOrder) };
        });
    }, []);

    const createGoal = useCallback(
        async (input: GoalInput) => {
            const { goal } = await api.createGoal(input);
            applyGoal(goal);
        },
        [applyGoal],
    );

    const updateGoal = useCallback(
        async (id: string, input: GoalInput) => {
            const { goal } = await api.updateGoal(id, input);
            applyGoal(goal);
        },
        [applyGoal],
    );

    const setGoalProgress = useCallback(
        (id: string, current: number) =>
            run(async () => {
                const { goal } = await api.setGoalProgress(id, current);
                applyGoal(goal);
            })(),
        [run, applyGoal],
    );

    const deleteGoal = useCallback(
        (id: string) =>
            run(async () => {
                await api.deleteGoal(id);
                setState((prev) => (prev ? { ...prev, goals: prev.goals.filter((g) => g.id !== id) } : prev));
            })(),
        [run],
    );

    const importTasks = useCallback(
        async (text: string) => {
            if (!state) return;
            await api.importTasks(text, state.preferences.timeZone);
            // Refetch: imported "#name" tokens may have created projects.
            setState(await api.getState());
            setRevision((r) => r + 1);
        },
        [state],
    );

    const togglePinProject = useCallback(
        (id: string, pinned: boolean) =>
            run(async () => {
                const { project } = await api.setProjectPinned(id, pinned);
                setState((prev) =>
                    prev
                        ? { ...prev, projects: prev.projects.map((p) => (p.id === id ? project : p)) }
                        : prev,
                );
            })(),
        [run],
    );

    const deleteProject = useCallback(
        (id: string) =>
            run(async () => {
                await api.deleteProject(id);
                // The server cascades to the project's tasks, so drop them here too.
                setState((prev) =>
                    prev
                        ? {
                                ...prev,
                                projects: prev.projects.filter((p) => p.id !== id),
                                tasks: prev.tasks.filter((t) => t.projectId !== id),
                            }
                        : prev,
                );
                if (view.name === "project" && view.id === id) navigate("/app");
                setRevision((r) => r + 1);
            })(),
        [run, view, navigate],
    );

    const saveTask = useCallback(
        async (patch: Record<string, unknown>) => {
            if (!editing) return;
            const { task } = await api.updateTask(editing.id, patch);
            setState((prev) =>
                prev ? { ...prev, tasks: prev.tasks.map((t) => (t.id === task.id ? task : t)) } : prev,
            );
            setRevision((r) => r + 1);
        },
        [editing],
    );

    const setPreferences = useCallback((preferences: Preferences) => {
        setState((prev) => (prev ? { ...prev, preferences } : prev));
    }, []);

    /**
     * Applied at once, then saved; a failed save puts the server's copy back.
     * Hidden projects are a preference so the choice follows the account.
     */
    const setInboxHidden = useCallback(
        (inboxHiddenProjects: string[]) => {
            setState((prev) =>
                prev ? { ...prev, preferences: { ...prev.preferences, inboxHiddenProjects } } : prev,
            );
            api.setPreferences({ inboxHiddenProjects })
                .then(({ preferences }) => {
                    setPreferences(preferences);
                    setNotice(null);
                })
                .catch((e: Error) => {
                    setNotice(e.message);
                    api.getState().then(setState).catch(() => {});
                });
        },
        [setPreferences],
    );

    const filtered = useMemo(() => {
        if (!state) return [];
        if (view.name === "project") return state.tasks.filter((t) => t.projectId === view.id);
        const hidden = new Set(state.preferences.inboxHiddenProjects);
        return state.tasks.filter((t) => !hidden.has(t.projectId));
    }, [state, view]);

    if (error) {
        return (
            <div className="fatal">
                {/* The service worker can serve this shell with no network, so say why it's empty. */}
                <h1>{navigator.onLine ? "Couldn’t load" : "You’re offline"}</h1>
                <p>{error}</p>
            </div>
        );
    }

    if (!state) {
        return <div className="loading">Loading…</div>;
    }

    const today = todayKey(state.preferences.timeZone);
    const overdueCount = state.tasks.filter((t) => t.due && t.due.date < today).length;
    const todayCount = state.tasks.filter((t) => t.due && t.due.date <= today).length;

    return (
        <div className="shell">
            <div className="grain" aria-hidden="true" />

            <Sidebar
                state={state}
                view={view}
                todayCount={todayCount}
                overdueCount={overdueCount}
                navigate={navigate}
                onTogglePin={togglePinProject}
                onDeleteProject={deleteProject}
                onCheckHabit={checkHabitToday}
                onNewHabit={() => setNewHabit(true)}
            />

            <main className={`main${view.name === "calendar" ? " main-full" : ""}`}>
                <TimeZoneNotice
                    preferences={state.preferences}
                    onSwitch={(timeZone) =>
                        run(async () => {
                            const { preferences } = await api.setPreferences({ timeZone });
                            setState((prev) => (prev ? { ...prev, preferences } : prev));
                            setRevision((r) => r + 1);
                        })()
                    }
                />

                {notice && (
                    <p className="banner banner-bad" role="alert" onClick={() => setNotice(null)}>
                        {notice}
                    </p>
                )}

                {view.name !== "settings" && view.name !== "calendar" && view.name !== "trash" && view.name !== "habit" && view.name !== "goals" && (
                    <QuickAdd
                        preferences={state.preferences}
                        projects={state.projects}
                        onSubmit={addTask}
                        onPasteMany={setImportText}
                    />
                )}

                {view.name === "settings" ? (
                    <Settings
                        preferences={state.preferences}
                        user={state.user}
                        onPreferencesChange={setPreferences}
                    />
                ) : view.name === "habit" ? (
                    (() => {
                        const habit = state.habits.find((h) => h.id === view.id);
                        return habit ? (
                            <HabitView
                                habit={habit}
                                today={todayKey(state.preferences.timeZone)}
                                revision={habitRevision}
                                onChanged={applyHabit}
                                onUpdate={updateHabit}
                                onDelete={deleteHabit}
                            />
                        ) : (
                            <p className="habit-empty">That habit doesn't exist any more.</p>
                        );
                    })()
                ) : view.name === "goals" ? (
                    <GoalsView
                        goals={state.goals}
                        today={today}
                        onCreate={createGoal}
                        onUpdate={updateGoal}
                        onProgress={setGoalProgress}
                        onDelete={deleteGoal}
                    />
                ) : view.name === "trash" ? (
                    <Trash projects={state.projects} onChanged={reload} />
                ) : view.name === "calendar" ? (
                    <WeekCalendar
                        timeZone={state.preferences.timeZone}
                        revision={revision}
                        onOpenTask={(id) => {
                            const task = state.tasks.find((t) => t.id === id);
                            if (task) setEditing(task);
                        }}
                    />
                ) : (
                    <>
                        {view.name === "inbox" ? (
                            <div className="view-head">
                                <h1 className="view-title">{titleFor(view, state)}</h1>
                                <ProjectFilter
                                    projects={state.projects}
                                    hidden={state.preferences.inboxHiddenProjects}
                                    onChange={setInboxHidden}
                                />
                            </div>
                        ) : (
                            <h1 className="view-title">{titleFor(view, state)}</h1>
                        )}
                        <TaskList
                            tasks={filtered}
                            projects={state.projects}
                            timeZone={state.preferences.timeZone}
                            groupByDate={view.name !== "project"}
                            emptyMessage={
                                filtered.length < state.tasks.length && view.name === "inbox"
                                    ? "Nothing in the projects you're showing."
                                    : emptyFor(view)
                            }
                            onComplete={completeTask}
                            onDelete={(id) =>
                                setPendingTaskDelete(state.tasks.find((t) => t.id === id) ?? null)
                            }
                            onOpen={setEditing}
                        />
                    </>
                )}
            </main>

            {newHabit && <HabitModal onSave={createHabit} onClose={() => setNewHabit(false)} />}

            {pendingTaskDelete && (
                <ConfirmDialog
                    title="Delete task?"
                    message={`"${pendingTaskDelete.content}" will move to the Trash. You can restore it from there.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        deleteTask(pendingTaskDelete.id);
                        setPendingTaskDelete(null);
                    }}
                    onCancel={() => setPendingTaskDelete(null)}
                />
            )}

            {importText !== null && state && (
                <ImportModal
                    initialText={importText}
                    preferences={state.preferences}
                    projects={state.projects}
                    onImport={importTasks}
                    onClose={() => setImportText(null)}
                />
            )}

            {editing && state && (
                <TaskModal
                    task={editing}
                    projects={state.projects}
                    onSave={saveTask}
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    );
}

function titleFor(view: View, state: AppState): string {
    switch (view.name) {
        case "inbox":
            return "Inbox";
        case "project":
            return state.projects.find((p) => p.id === view.id)?.name ?? "Project";
        default:
            return "";
    }
}

function emptyFor(view: View): string {
    switch (view.name) {
        case "inbox":
            return "Nothing here. Add a task to get started.";
        default:
            return "No tasks here yet.";
    }
}

export type { Task };
