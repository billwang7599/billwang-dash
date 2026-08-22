import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavKey, Task } from "../shared/types.ts";
import { api, type AppState, type Preferences } from "./api.ts";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { Settings } from "./components/Settings.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { TaskModal } from "./components/TaskModal.tsx";
import { WeekCalendar } from "./components/WeekCalendar.tsx";
import { todayKey } from "./format.ts";

type View =
  | { name: NavKey }
  | { name: "settings" }
  | { name: "project"; id: string };

/** Label and route for each reorderable nav item. */
const NAV_VIEWS: Record<NavKey, { label: string; path: string }> = {
  today: { label: "Today", path: "/app" },
  upcoming: { label: "Upcoming", path: "/app/upcoming" },
  inbox: { label: "Inbox", path: "/app/inbox" },
  calendar: { label: "Calendar", path: "/app/calendar" },
};

/** What a sidebar row is being dragged out of; the two lists reorder apart. */
type Drag = { kind: "nav" | "project"; id: string };

/** Moves the matched item to the matched target's slot. Null if either is gone. */
function reorder<T>(
  items: readonly T[],
  isMoving: (item: T) => boolean,
  isTarget: (item: T) => boolean,
): T[] | null {
  const from = items.findIndex(isMoving);
  const to = items.findIndex(isTarget);
  if (from === -1 || to === -1) return null;

  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

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
  const [drag, setDrag] = useState<Drag | null>(null);
  // Not persisted: collapsing is a session-only UI preference, not a saved one.
  const [collapsed, setCollapsed] = useState(false);
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
   * Optimistic: the sidebar reorders immediately, the write follows. The order
   * is computed before setState rather than inside the updater — an updater has
   * not necessarily run by the next line, so reading the result back out of one
   * would leave the write with nothing to send.
   */
  const dropProject = useCallback(
    (targetId: string) =>
      run(async () => {
        if (drag?.kind !== "project" || drag.id === targetId) return;
        setDrag(null);
        if (!state) return;

        const others = state.projects.filter((p) => !p.isInbox);
        const next = reorder(others, (p) => p.id === drag.id, (p) => p.id === targetId);
        if (!next) return;

        const inbox = state.projects.filter((p) => p.isInbox);
        setState((prev) => (prev ? { ...prev, projects: [...inbox, ...next] } : prev));
        await api.reorderProjects(next.map((p) => p.id));
      })(),
    [drag, state, run],
  );

  /** Same optimistic reorder, over the fixed views instead of the projects. */
  const dropNav = useCallback(
    (targetKey: NavKey) =>
      run(async () => {
        if (drag?.kind !== "nav" || drag.id === targetKey) return;
        setDrag(null);
        if (!state) return;

        const navOrder = reorder(
          state.preferences.navOrder,
          (k) => k === drag.id,
          (k) => k === targetKey,
        );
        if (!navOrder) return;

        setState((prev) =>
          prev ? { ...prev, preferences: { ...prev.preferences, navOrder } } : prev,
        );
        await api.setPreferences({ navOrder });
      })(),
    [drag, state, run],
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
    <div className={`shell${collapsed ? " is-collapsed" : ""}`}>
      <div className="grain" aria-hidden="true" />

      <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
        <div className="sidebar-top">
          {/* The tail is dropped by CSS, not here: the narrow-screen layout
              keeps the full wordmark even while the menu is collapsed. */}
          <a className="wordmark" href="/">
            d<span className="wordmark-tail">ash</span>
            <span className="dot">.</span>
          </a>
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        <nav>
          {state.preferences.navOrder.map((key) => (
            <NavItem
              key={key}
              label={NAV_VIEWS[key].label}
              count={key === "today" ? todayCount : undefined}
              urgent={key === "today" && overdueCount > 0}
              active={view.name === key}
              collapsed={collapsed}
              onClick={() => navigate(NAV_VIEWS[key].path)}
              draggable
              dragging={drag?.kind === "nav" && drag.id === key}
              onDragStart={() => setDrag({ kind: "nav", id: key })}
              onDragEnd={() => setDrag(null)}
              onDrop={() => dropNav(key)}
            />
          ))}
        </nav>

        {state.projects.filter((p) => !p.isInbox).length > 0 && (
          <>
            {!collapsed && <p className="nav-head">Projects</p>}
            <nav className={collapsed ? "nav-divided" : undefined}>
              {state.projects
                .filter((p) => !p.isInbox)
                .map((project) => (
                  <NavItem
                    key={project.id}
                    label={project.name}
                    count={state.tasks.filter((t) => t.projectId === project.id).length}
                    active={view.name === "project" && view.id === project.id}
                    collapsed={collapsed}
                    onClick={() => navigate(`/app/project/${project.id}`)}
                    draggable
                    dragging={drag?.kind === "project" && drag.id === project.id}
                    onDragStart={() => setDrag({ kind: "project", id: project.id })}
                    onDragEnd={() => setDrag(null)}
                    onDrop={() => dropProject(project.id)}
                  />
                ))}
            </nav>
          </>
        )}

        <div className="sidebar-foot">
          <NavItem
            label="Settings"
            active={view.name === "settings"}
            collapsed={collapsed}
            onClick={() => navigate("/app/settings")}
          />
          {!collapsed && (
            <>
              <p className="whoami">{state.user.email}</p>
              {/* A plain link, not fetch(): signing out is a full navigation to
                  Cloudflare Access, and the in-memory app state must not survive it. */}
              <a className="signout" href="/logout">
                Sign out
              </a>
            </>
          )}
        </div>
      </aside>

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

function NavItem({
  label,
  count,
  urgent,
  active,
  collapsed,
  onClick,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  label: string;
  count?: number;
  urgent?: boolean;
  active: boolean;
  collapsed?: boolean;
  onClick: () => void;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
}) {
  const hasCount = count !== undefined && count > 0;
  return (
    <button
      className={`nav-item${active ? " is-active" : ""}${dragging ? " is-dragging" : ""}${
        collapsed ? " is-collapsed" : ""
      }`}
      onClick={onClick}
      // Collapsed rows are down to an initial, so the name lives in the tooltip.
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      // Without preventDefault the drop event never fires.
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={
        onDrop
          ? (e) => {
              e.preventDefault();
              onDrop();
            }
          : undefined
      }
    >
      <span aria-hidden={collapsed || undefined}>
        {collapsed ? label.slice(0, 1).toUpperCase() : label}
      </span>
      {hasCount && !collapsed && (
        <span className={`nav-count${urgent ? " is-urgent" : ""}`}>{count}</span>
      )}
      {hasCount && collapsed && (
        <span className={`nav-pip${urgent ? " is-urgent" : ""}`} aria-hidden="true" />
      )}
    </button>
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
