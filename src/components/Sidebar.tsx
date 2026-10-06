import { useEffect, useMemo, useState } from "react";
import type { AppState } from "../api.ts";
import type { View } from "../App.tsx";
import type { HabitSummary } from "../../shared/habits.ts";
import type { Project } from "../../shared/types.ts";
import { NARROW, useMediaQuery } from "../useMediaQuery.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ProjectSearch } from "./ProjectSearch.tsx";

type ProjectSort = "alphabetical" | "recent";

const SORT_LABEL: Record<ProjectSort, string> = {
    alphabetical: "A–Z",
    recent: "Recent",
};

const NEXT_SORT: Record<ProjectSort, ProjectSort> = {
    alphabetical: "recent",
    recent: "alphabetical",
};

interface Props {
    state: AppState;
    view: View;
    todayCount: number;
    overdueCount: number;
    navigate: (path: string) => void;
    onTogglePin: (id: string, pinned: boolean) => void;
    onDeleteProject: (id: string) => void;
    /** Check today off (or undo it) from the sidebar. */
    onCheckHabit: (habit: HabitSummary) => void;
    onNewHabit: () => void;
}

/** The two fixed views. Order is fixed too -- not user-reorderable. */
const NAV_VIEWS: { key: "inbox" | "calendar"; label: string; path: string }[] = [
    { key: "inbox", label: "Inbox", path: "/app" },
    { key: "calendar", label: "Calendar", path: "/app/calendar" },
];

export function Sidebar({
    state,
    view,
    todayCount,
    overdueCount,
    navigate,
    onTogglePin,
    onDeleteProject,
    onCheckHabit,
    onNewHabit,
}: Props) {
    // Not persisted: collapsing is a session-only UI preference, not a saved one.
    const [collapsedPref, setCollapsed] = useState(false);
    // On a phone the sidebar is an off-canvas drawer instead, and is never the
    // narrow initials column -- the drawer has the room for full labels.
    const narrow = useMediaQuery(NARROW);
    const collapsed = collapsedPref && !narrow;
    const [drawerOpen, setDrawerOpen] = useState(false);
    const drawerShown = narrow && drawerOpen;

    /** Every destination closes the drawer, so the page you picked is what you see. */
    const go = (path: string) => {
        setDrawerOpen(false);
        navigate(path);
    };

    useEffect(() => {
        if (!drawerShown) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [drawerShown]);
    // Not persisted either -- same reasoning as collapsed.
    const [projectSort, setProjectSort] = useState<ProjectSort>("alphabetical");
    const [searchOpen, setSearchOpen] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                // Ctrl+K opens the browser's own search bar in Firefox otherwise.
                e.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

    const deleteMessage = (project: Project) => {
        const n = state.tasks.filter((t) => t.projectId === project.id).length;
        const detail = n > 0 ? ` and its ${n} open task${n === 1 ? "" : "s"}` : "";
        return `"${project.name}"${detail} will move to the Trash. You can restore them from there.`;
    };

    const { pinned, unpinned } = useMemo(() => {
        const others = state.projects.filter((p) => !p.isInbox);
        const sorted =
            projectSort === "alphabetical"
                ? [...others].sort((a, b) => a.name.localeCompare(b.name))
                : [...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { pinned: sorted.filter((p) => p.pinned), unpinned: sorted.filter((p) => !p.pinned) };
    }, [state.projects, projectSort]);

    return (
        <>
            {/* Phone only (hidden by CSS above the breakpoint): the drawer's handle. */}
            <header className="mobile-bar">
                <button
                    className="mobile-menu"
                    onClick={() => setDrawerOpen(true)}
                    aria-label="Open menu"
                    aria-expanded={drawerShown}
                    aria-controls="sidebar"
                >
                    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                        <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                </button>
                <a className="wordmark" href="/">
                    dash<span className="dot">.</span>
                </a>
            </header>

            <aside
                id="sidebar"
                className={`sidebar${collapsed ? " is-collapsed" : ""}${drawerShown ? " is-open" : ""}`}
            >
                <div className="sidebar-top">
                    <a className="wordmark" href="/">
                        d<span className="wordmark-tail">ash</span>
                        <span className="dot">.</span>
                    </a>
                    {narrow ? (
                        <button className="sidebar-toggle" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
                            ✕
                        </button>
                    ) : (
                        <button
                            className="sidebar-toggle"
                            onClick={() => setCollapsed(!collapsed)}
                            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                            aria-expanded={!collapsed}
                            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        >
                            {collapsed ? "»" : "«"}
                        </button>
                    )}
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
                            onClick={() => go(path)}
                        />
                    ))}
                </nav>

                {pinned.length > 0 && (
                    <>
                        {!collapsed && <p className="nav-head">Pinned</p>}
                        <nav className={collapsed ? "nav-divided" : undefined}>
                            {pinned.map((project) => (
                                <ProjectRow
                                    key={project.id}
                                    label={project.name}
                                    count={state.tasks.filter((t) => t.projectId === project.id).length}
                                    active={view.name === "project" && view.id === project.id}
                                    collapsed={collapsed}
                                    pinned
                                    onClick={() => go(`/app/project/${project.id}`)}
                                    onTogglePin={() => onTogglePin(project.id, false)}
                                    onDelete={() => setPendingDelete(project)}
                                />
                            ))}
                        </nav>
                    </>
                )}

                {unpinned.length > 0 && (
                    <>
                        {!collapsed && (
                            <div className="nav-head-row">
                                <p className="nav-head">Projects</p>
                                <div className="nav-head-actions">
                                    <button
                                        className="sort-toggle"
                                        onClick={() => setSearchOpen(true)}
                                        title="Search projects (⌘K)"
                                        aria-label="Search projects"
                                    >
                                        Search
                                    </button>
                                    <button
                                        className="sort-toggle"
                                        onClick={() => setProjectSort(NEXT_SORT[projectSort])}
                                        title="Change project sort order"
                                    >
                                        {SORT_LABEL[projectSort]}
                                    </button>
                                </div>
                            </div>
                        )}
                        <nav className={collapsed ? "nav-divided" : undefined}>
                            {unpinned.map((project) => (
                                <ProjectRow
                                    key={project.id}
                                    label={project.name}
                                    count={state.tasks.filter((t) => t.projectId === project.id).length}
                                    active={view.name === "project" && view.id === project.id}
                                    collapsed={collapsed}
                                    pinned={false}
                                    onClick={() => go(`/app/project/${project.id}`)}
                                    onTogglePin={() => onTogglePin(project.id, true)}
                                    onDelete={() => setPendingDelete(project)}
                                />
                            ))}
                        </nav>
                    </>
                )}

                {!collapsed && (
                    <>
                        <div className="nav-head-row">
                            <p className="nav-head">Habits</p>
                            <div className="nav-head-actions">
                                <button className="sort-toggle" onClick={() => {
                                        setDrawerOpen(false);
                                        onNewHabit();
                                    }}
                                    aria-label="New habit"
                                >
                                    + New
                                </button>
                            </div>
                        </div>
                        <nav>
                            {state.habits.map((habit) => (
                                <div className="habit-row" key={habit.id}>
                                    <button
                                        className={`habit-check${habit.today ? ` is-${habit.today}` : ""}`}
                                        onClick={() => onCheckHabit(habit)}
                                        aria-label={`${habit.today === "done" ? "Undo" : "Check off"} ${habit.name} today`}
                                        aria-pressed={habit.today === "done"}
                                        title={habit.today === "done" ? "Done today. Click to undo" : "Check off today"}
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
                                    <NavItem
                                        label={habit.name}
                                        count={habit.stats.streak}
                                        active={view.name === "habit" && view.id === habit.id}
                                        collapsed={false}
                                        onClick={() => go(`/app/habit/${habit.id}`)}
                                    />
                                </div>
                            ))}
                            {state.habits.length === 0 && (
                                <p className="habit-empty">Track something you want to do regularly.</p>
                            )}
                        </nav>
                    </>
                )}

                <div className="sidebar-foot">
                    <NavItem
                        label="Trash"
                        active={view.name === "trash"}
                        collapsed={collapsed}
                        onClick={() => go("/app/trash")}
                    />
                    <NavItem
                        label="Settings"
                        active={view.name === "settings"}
                        collapsed={collapsed}
                        onClick={() => go("/app/settings")}
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

            {drawerShown && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

            {pendingDelete && (
                <ConfirmDialog
                    title="Delete project?"
                    message={deleteMessage(pendingDelete)}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        onDeleteProject(pendingDelete.id);
                        setPendingDelete(null);
                    }}
                    onCancel={() => setPendingDelete(null)}
                />
            )}

            {searchOpen && (
                <ProjectSearch
                    projects={[...pinned, ...unpinned]}
                    onSelect={(project) => {
                        setSearchOpen(false);
                        go(`/app/project/${project.id}`);
                    }}
                    onClose={() => setSearchOpen(false)}
                />
            )}
        </>
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

/**
 * NavItem plus a pin toggle. The toggle is a sibling, not a child of the
 * NavItem button -- a <button> can't nest another interactive control.
 */
function ProjectRow({
    label,
    count,
    active,
    collapsed,
    pinned,
    onClick,
    onTogglePin,
    onDelete,
}: {
    label: string;
    count: number;
    active: boolean;
    collapsed: boolean;
    pinned: boolean;
    onClick: () => void;
    onTogglePin: () => void;
    onDelete: () => void;
}) {
    return (
        <div className="nav-row">
            <NavItem label={label} count={count} active={active} collapsed={collapsed} onClick={onClick} />
            {!collapsed && (
                <div className="row-actions">
                    <button
                        className="row-action"
                        onClick={onTogglePin}
                        title={pinned ? "Unpin project" : "Pin project"}
                        aria-label={pinned ? "Unpin project" : "Pin project"}
                    >
                        {pinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                        className="row-action row-action-danger"
                        onClick={onDelete}
                        title="Delete project"
                        aria-label="Delete project"
                    >
                        Delete
                    </button>
                </div>
            )}
        </div>
    );
}
