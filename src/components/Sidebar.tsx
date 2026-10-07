import { useEffect, useMemo, useState } from "react";
import type { AppState } from "../api.ts";
import type { View } from "../App.tsx";
import { HORIZONS, isDone, progress } from "../../shared/goals.ts";
import type { HabitSummary } from "../../shared/habits.ts";
import type { Project } from "../../shared/types.ts";
import { goalColors } from "../projectColors.ts";
import { projectDeleteMessage } from "../projectDelete.ts";
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
    /** Project id -> card colour, shown as a dot beside each project. */
    colors: Map<string, string>;
    onTogglePin: (id: string, pinned: boolean) => void;
    onDeleteProject: (id: string) => void;
    /** Check today off (or undo it) from the sidebar. */
    onCheckHabit: (habit: HabitSummary) => void;
}

/** The fixed views. Order is fixed too -- not user-reorderable. */
const NAV_VIEWS: { key: "inbox" | "calendar" | "assistant"; label: string; path: string }[] = [
    { key: "inbox", label: "Inbox", path: "/app" },
    { key: "calendar", label: "Calendar", path: "/app/calendar" },
    { key: "assistant", label: "Assistant", path: "/app/assistant" },
];

export function Sidebar({
    state,
    view,
    todayCount,
    overdueCount,
    navigate,
    colors,
    onTogglePin,
    onDeleteProject,
    onCheckHabit,
}: Props) {
    // Desktop only: on a phone App shows MobileNav instead of this sidebar.
    // Not persisted: collapsing is a session-only UI preference, not a saved one.
    const [collapsed, setCollapsed] = useState(false);
    const go = navigate;
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

    /** Open goals, short term first; within a horizon the server's deadline order holds. */
    const openGoals = useMemo(
        () =>
            state.goals
                .filter((g) => !isDone(g))
                .sort((a, b) => HORIZONS.indexOf(a.horizon) - HORIZONS.indexOf(b.horizon)),
        [state.goals],
    );

    const goalColor = useMemo(() => goalColors(state.goals), [state.goals]);

    const { pinned, unpinned } = useMemo(() => {
        const others = state.projects.filter((p) => !p.isInbox);
        const sorted =
            projectSort === "alphabetical"
                ? [...others].sort((a, b) => a.name.localeCompare(b.name))
                : [...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { pinned: sorted.filter((p) => p.pinned), unpinned: sorted.filter((p) => !p.pinned) };
    }, [state.projects, projectSort]);

    // The sidebar greets you; the wordmark lives at the top of Settings instead.
    const firstName = state.preferences.firstName;
    const greeting = firstName ? `Hello, ${firstName}!` : "Hello!";

    return (
        <>
            <aside id="sidebar" className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
                <div className="sidebar-top">
                    {/* Collapsed, there's no room for a greeting; the "d." mark stays. */}
                    {collapsed ? (
                        <a className="wordmark" href="/">
                            d<span className="wordmark-tail">ash</span>
                            <span className="dot">.</span>
                        </a>
                    ) : (
                        <p className="greeting">{greeting}</p>
                    )}
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
                                    swatch={colors.get(project.id)}
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
                                <button
                                    className={`nav-head nav-head-link${view.name === "projects" ? " is-active" : ""}`}
                                    onClick={() => go("/app/projects")}
                                >
                                    Projects
                                </button>
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
                                    swatch={colors.get(project.id)}
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
                            <button
                                className={`nav-head nav-head-link${view.name === "goals" ? " is-active" : ""}`}
                                onClick={() => go("/app/goals")}
                            >
                                Goals
                            </button>
                        </div>
                        <nav>
                            {openGoals.map((goal) => (
                                <button
                                    key={goal.id}
                                    className="nav-item goal-nav"
                                    onClick={() => go("/app/goals")}
                                    title={
                                        goal.target === null
                                            ? undefined
                                            : `${goal.current} / ${goal.target}${goal.unit ? ` ${goal.unit}` : ""}`
                                    }
                                >
                                    <span className="nav-label goal-nav-title">
                                        <span
                                            className="nav-swatch"
                                            style={{ background: goalColor.get(goal.id) }}
                                            aria-hidden="true"
                                        />
                                        {goal.title}
                                    </span>
                                    {goal.target !== null && (
                                        <span className="goal-bar goal-bar-thin" aria-hidden="true">
                                            <span style={{ width: `${progress(goal) * 100}%` }} />
                                        </span>
                                    )}
                                </button>
                            ))}
                            {openGoals.length === 0 && (
                                <p className="habit-empty">Set something specific to aim for.</p>
                            )}
                        </nav>
                    </>
                )}

                {!collapsed && (
                    <>
                        <div className="nav-head-row">
                            <button
                                className={`nav-head nav-head-link${view.name === "habits" ? " is-active" : ""}`}
                                onClick={() => go("/app/habits")}
                            >
                                Habits
                            </button>
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
                    {/* Recently deleted and sign out live in Settings. */}
                    <NavItem
                        label="Settings"
                        active={view.name === "settings" || view.name === "trash"}
                        collapsed={collapsed}
                        onClick={() => go("/app/settings")}
                    />
                </div>
            </aside>

            {pendingDelete && (
                <ConfirmDialog
                    title="Delete project?"
                    message={projectDeleteMessage(pendingDelete, state.tasks)}
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
    swatch,
    count,
    urgent,
    active,
    collapsed,
    onClick,
}: {
    label: string;
    /** A colour dot before the label (projects). */
    swatch?: string;
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
            <span className="nav-label" aria-hidden={collapsed || undefined}>
                {swatch && <span className="nav-swatch" style={{ background: swatch }} aria-hidden="true" />}
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
    swatch,
    count,
    active,
    collapsed,
    pinned,
    onClick,
    onTogglePin,
    onDelete,
}: {
    label: string;
    swatch?: string;
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
            <NavItem
                label={label}
                swatch={swatch}
                count={count}
                active={active}
                collapsed={collapsed}
                onClick={onClick}
            />
            {!collapsed && (
                <div className="row-actions">
                    <button
                        className={`row-action${pinned ? " is-on" : ""}`}
                        onClick={onTogglePin}
                        title={pinned ? "Unpin project" : "Pin project"}
                        aria-label={pinned ? "Unpin project" : "Pin project"}
                        aria-pressed={pinned}
                    >
                        {/* A pushpin; filled while pinned. */}
                        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                            <path
                                d="M6 2h4l-.5 4 2.5 2.5v1H4v-1L6.5 6 6 2zM8 9.5V14"
                                fill={pinned ? "currentColor" : "none"}
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        </svg>
                    </button>
                    <button
                        className="row-action row-action-danger"
                        onClick={onDelete}
                        title="Delete project"
                        aria-label="Delete project"
                    >
                        {/* A bin. */}
                        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                            <path
                                d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}
