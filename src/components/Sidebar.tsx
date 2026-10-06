import { useEffect, useMemo, useState } from "react";
import type { AppState } from "../api.ts";
import type { View } from "../App.tsx";
import type { Project } from "../../shared/types.ts";
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
}: Props) {
    // Not persisted: collapsing is a session-only UI preference, not a saved one.
    const [collapsed, setCollapsed] = useState(false);
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

    const confirmDelete = (project: Project) => {
        const n = state.tasks.filter((t) => t.projectId === project.id).length;
        const detail = n > 0 ? ` and its ${n} open task${n === 1 ? "" : "s"}` : "";
        if (window.confirm(`Delete "${project.name}"${detail}? This can't be undone.`)) {
            onDeleteProject(project.id);
        }
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
                                    onClick={() => navigate(`/app/project/${project.id}`)}
                                    onTogglePin={() => onTogglePin(project.id, false)}
                                    onDelete={() => confirmDelete(project)}
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
                                    onClick={() => navigate(`/app/project/${project.id}`)}
                                    onTogglePin={() => onTogglePin(project.id, true)}
                                    onDelete={() => confirmDelete(project)}
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

            {searchOpen && (
                <ProjectSearch
                    projects={[...pinned, ...unpinned]}
                    onSelect={(project) => {
                        setSearchOpen(false);
                        navigate(`/app/project/${project.id}`);
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
