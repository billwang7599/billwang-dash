import { useState } from "react";
import type { AppState } from "../api.ts";
import type { View } from "../App.tsx";

interface Props {
  state: AppState;
  view: View;
  todayCount: number;
  overdueCount: number;
  navigate: (path: string) => void;
}

/** The two fixed views. Order is fixed too -- not user-reorderable. */
const NAV_VIEWS: { key: "inbox" | "calendar"; label: string; path: string }[] = [
  { key: "inbox", label: "Inbox", path: "/app" },
  { key: "calendar", label: "Calendar", path: "/app/calendar" },
];

export function Sidebar({ state, view, todayCount, overdueCount, navigate }: Props) {
  // Not persisted: collapsing is a session-only UI preference, not a saved one.
  const [collapsed, setCollapsed] = useState(false);

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
        {NAV_VIEWS.map(({ key, label, path }) => (
          <NavItem
            key={key}
            label={label}
            count={key === "inbox" ? todayCount : undefined}
            urgent={key === "inbox" && overdueCount > 0}
            active={view.name === key}
            collapsed={collapsed}
            onClick={() => navigate(path)}
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
}: {
  label: string;
  count?: number;
  urgent?: boolean;
  active: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) {
  const hasCount = count !== undefined && count > 0;
  return (
    <button
      className={`nav-item${active ? " is-active" : ""}${collapsed ? " is-collapsed" : ""}`}
      onClick={onClick}
      // Collapsed rows are down to an initial, so the name lives in the tooltip.
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
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
