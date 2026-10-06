import { useMemo, useState } from "react";
import type { Project, Task } from "../../shared/types.ts";
import { formatDateLabel, formatTime } from "../format.ts";
import { projectDeleteMessage } from "../projectDelete.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Hero } from "./Hero.tsx";

type Sort = "alphabetical" | "recent";

interface Props {
    projects: Project[];
    /** Open tasks, for each project's count and next task. */
    tasks: Task[];
    /** Project id -> card colour, from projectColors. */
    colors: Map<string, string>;
    timeZone: string;
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    onOpen: (id: string) => void;
    onCreate: (name: string) => Promise<void>;
    onTogglePin: (id: string, pinned: boolean) => void;
    onDelete: (id: string) => void;
}

/** Every project as a colour tile: pinned first, then the rest, with a filter and a sort. */
export function ProjectsView({ projects, tasks, colors, timeZone, today, onOpen, onCreate, onTogglePin, onDelete }: Props) {
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<Sort>("alphabetical");
    const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
    const [newName, setNewName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return projects
            .filter((p) => !p.isInbox && (!q || p.name.toLowerCase().includes(q)))
            .sort((a, b) =>
                sort === "alphabetical" ? a.name.localeCompare(b.name) : b.createdAt.localeCompare(a.createdAt),
            );
    }, [projects, query, sort]);
    const pinned = shown.filter((p) => p.pinned);
    const rest = shown.filter((p) => !p.pinned);
    const openTasks = tasks.filter((t) => !projects.find((p) => p.id === t.projectId)?.isInbox).length;

    async function create(e: React.FormEvent) {
        e.preventDefault();
        if (!newName?.trim()) return;
        setError(null);
        try {
            await onCreate(newName.trim());
            setNewName(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    const tile = (p: Project) => {
        const own = tasks.filter((t) => t.projectId === p.id);
        const overdue = own.filter((t) => t.due && t.due.date < today).length;
        // The soonest dated task; the server's order breaks ties.
        const next = own
            .filter((t) => t.due)
            .sort((a, b) => (a.due!.date + (a.due!.time ?? "")).localeCompare(b.due!.date + (b.due!.time ?? "")))[0];
        return (
            <article key={p.id} className="ptile" style={{ ["--card-c" as string]: colors.get(p.id) }}>
                <div className="ptile-top">
                    <button className="ptile-name" onClick={() => onOpen(p.id)}>
                        {p.name}
                    </button>
                    <details className="goal-menu">
                        <summary aria-label={`Actions for ${p.name}`}>⋯</summary>
                        <div className="goal-menu-list">
                            <button onClick={() => onTogglePin(p.id, !p.pinned)}>{p.pinned ? "Unpin" : "Pin"}</button>
                            <button onClick={() => setPendingDelete(p)}>Delete</button>
                        </div>
                    </details>
                </div>
                <button className="ptile-foot" onClick={() => onOpen(p.id)} tabIndex={-1}>
                    <span className="ptile-count">
                        {own.length}
                        <small>
                            open{overdue > 0 && ` · ${overdue} overdue`}
                        </small>
                    </span>
                    <span className="ptile-next">
                        {next
                            ? `Next: ${next.content} · ${formatDateLabel(next.due!.date, timeZone)}${next.due!.time ? ` ${formatTime(next.due!.time)}` : ""}`
                            : "Nothing scheduled"}
                    </span>
                </button>
            </article>
        );
    };

    return (
        <div className="projects-view">
            <div className="view-bar">
                <input
                    className="projects-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter projects"
                    aria-label="Filter projects"
                />
                <div className="pill-group" role="group" aria-label="Sort projects">
                    {(["alphabetical", "recent"] as const).map((s) => (
                        <button
                            key={s}
                            className={`pill-btn${sort === s ? " is-on" : ""}`}
                            aria-pressed={sort === s}
                            onClick={() => setSort(s)}
                        >
                            {s === "alphabetical" ? "A–Z" : "Recent"}
                        </button>
                    ))}
                </div>
                {newName === null ? (
                    <button className="btn btn-primary" onClick={() => setNewName("")}>
                        + New project
                    </button>
                ) : (
                    <form className="new-project" onSubmit={create}>
                        <input
                            autoFocus
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => e.key === "Escape" && setNewName(null)}
                            placeholder="Project name"
                            aria-label="New project name"
                            maxLength={100}
                        />
                        <button className="btn btn-primary" type="submit" disabled={!newName.trim()}>
                            Add
                        </button>
                    </form>
                )}
            </div>
            {error && <p className="banner banner-bad">{error}</p>}

            <Hero
                kicker="Everything you're working on"
                title="Projects"
                stats={[
                    { value: projects.filter((p) => !p.isInbox).length, label: "projects" },
                    { value: openTasks, label: "open tasks" },
                ]}
            />

            {shown.length === 0 ? (
                <p className="habit-empty projects-empty">
                    {query ? "No projects match." : "No projects yet. Add one here, or with #name in a task."}
                </p>
            ) : (
                <>
                    {pinned.length > 0 && (
                        <section className="ptiles-section">
                            <h2 className="group-head">
                                Pinned <span className="group-count">{pinned.length}</span>
                            </h2>
                            <div className="ptiles">{pinned.map(tile)}</div>
                        </section>
                    )}
                    {rest.length > 0 && (
                        <section className="ptiles-section">
                            <h2 className="group-head">
                                {pinned.length > 0 ? "All projects" : "Projects"}{" "}
                                <span className="group-count">{rest.length}</span>
                            </h2>
                            <div className="ptiles">{rest.map(tile)}</div>
                        </section>
                    )}
                </>
            )}

            {pendingDelete && (
                <ConfirmDialog
                    title="Delete project?"
                    message={projectDeleteMessage(pendingDelete, tasks)}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        onDelete(pendingDelete.id);
                        setPendingDelete(null);
                    }}
                    onCancel={() => setPendingDelete(null)}
                />
            )}
        </div>
    );
}
