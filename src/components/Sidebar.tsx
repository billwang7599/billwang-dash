import { useState } from "react";
import type { NavKey } from "../../shared/types.ts";
import type { AppState } from "../api.ts";
import type { View } from "../App.tsx";

interface Props {
  state: AppState;
  view: View;
  todayCount: number;
  overdueCount: number;
  navigate: (path: string) => void;
  onReorderNav: (navOrder: NavKey[]) => void;
  onReorderProjects: (ids: string[]) => void;
}

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

export function Sidebar({
  state,
  view,
  todayCount,
  overdueCount,
  navigate,
  onReorderNav,
  onReorderProjects,
}: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Not persisted: collapsing is a session-only UI preference, not a saved one.
  const [collapsed, setCollapsed] = useState(false);

  const dropNav = (targetKey: NavKey) => {
    if (drag?.kind !== "nav" || drag.id === targetKey) return;
    setDrag(null);

    const navOrder = reorder(
      state.preferences.navOrder,
      (k) => k === drag.id,
      (k) => k === targetKey,
    );
    if (navOrder) onReorderNav(navOrder);
  };

  const dropProject = (targetId: string) => {
    if (drag?.kind !== "project" || drag.id === targetId) return;
    setDrag(null);

    const others = state.projects.filter((p) => !p.isInbox);
    const next = reorder(others, (p) => p.id === drag.id, (p) => p.id === targetId);
    if (next) onReorderProjects(next.map((p) => p.id));
  };

  return (
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
