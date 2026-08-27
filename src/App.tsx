import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavKey, Task } from "../shared/types.ts";
import { api, type AppState, type Preferences } from "./api.ts";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { TaskModal } from "./components/TaskModal.tsx";
import { WeekCalendar } from "./components/WeekCalendar.tsx";
import { todayKey } from "./format.ts";

export type View =
  | { name: NavKey }
  | { name: "settings" }
  | { name: "project"; id: string };

function viewFromPath(pathname: string): View {
  const rest = pathname.replace(/^\/app\/?/, "").replace(/\/$/, "");
  if (rest.startsWith("project/")) return { name: "project", id: rest.slice(8) };
  if (rest === "upcoming") return { name: "upcoming" };
  if (rest === "inbox") return { name: "inbox" };
  if (rest === "calendar") return { name: "calendar" };
  if (rest === "settings") return { name: "settings" };
  return { name: "today" };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
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

  /**
   * Optimistic: the sidebar reorders immediately, the write follows. Sidebar
   * computes the new order (it owns the drag gesture); App just persists it.
   */
  const reorderProjects = useCallback(
    (ids: string[]) =>
      run(async () => {
        setState((prev) => {
          if (!prev) return prev;
          const byId = new Map(prev.projects.map((p) => [p.id, p]));
          const inbox = prev.projects.filter((p) => p.isInbox);
          const reordered = ids.map((id) => byId.get(id)).filter((p) => p !== undefined);
          return { ...prev, projects: [...inbox, ...reordered] };
        });
        await api.reorderProjects(ids);
      })(),
    [run],
  );

  const reorderNav = useCallback(
    (navOrder: NavKey[]) =>
      run(async () => {
        setState((prev) =>
          prev ? { ...prev, preferences: { ...prev.preferences, navOrder } } : prev,
        );
        await api.setPreferences({ navOrder });
      })(),
    [run],
  );

  const setPreferences = useCallback((preferences: Preferences) => {
    setState((prev) => (prev ? { ...prev, preferences } : prev));
  }, []);

  const filtered = useMemo(() => {
    if (!state) return [];
    const today = todayKey(state.preferences.timeZone);

    switch (view.name) {
      case "today":
        return state.tasks.filter((t) => t.due && t.due.date <= today);
      case "upcoming":
        return state.tasks.filter((t) => t.due && t.due.date > today);
      case "inbox":
        return state.tasks.filter((t) => t.projectId === "inbox");
      case "project":
        return state.tasks.filter((t) => t.projectId === view.id);
      default:
        return state.tasks;
    }
  }, [state, view]);

  if (error) {
    return (
      <div className="fatal">
        <h1>Couldn’t load</h1>
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
        onReorderNav={reorderNav}
        onReorderProjects={reorderProjects}
      />

      <main className="main">
        {notice && (
          <p className="banner banner-bad" role="alert" onClick={() => setNotice(null)}>
            {notice}
          </p>
        )}

        {view.name !== "settings" && view.name !== "calendar" && (
          <QuickAdd preferences={state.preferences} onSubmit={addTask} />
        )}

        {view.name === "settings" ? (
          <Settings
            preferences={state.preferences}
            user={state.user}
            onPreferencesChange={setPreferences}
          />
        ) : view.name === "calendar" ? (
          <WeekCalendar timeZone={state.preferences.timeZone} revision={revision} />
        ) : (
          <>
            <h1 className="view-title">{titleFor(view, state)}</h1>
            <TaskList
              tasks={filtered}
              projects={state.projects}
              timeZone={state.preferences.timeZone}
              groupByDate={view.name !== "inbox" && view.name !== "project"}
              emptyMessage={emptyFor(view)}
              onComplete={completeTask}
              onDelete={deleteTask}
              onOpen={setEditing}
            />
          </>
        )}
      </main>

      {editing && state && (
        <TaskModal
          task={editing}
          projects={state.projects}
          timeZone={state.preferences.timeZone}
          onSave={saveTask}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function titleFor(view: View, state: AppState): string {
  switch (view.name) {
    case "today":
      return "Today";
    case "upcoming":
      return "Upcoming";
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
    case "today":
      return "Nothing due today. Enjoy it.";
    case "upcoming":
      return "Nothing scheduled ahead.";
    case "inbox":
      return "Inbox is empty.";
    default:
      return "No tasks here yet.";
  }
}

export type { Task };
