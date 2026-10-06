import { useMemo, useState } from "react";
import type { Project, Task } from "../../shared/types.ts";
import { projectDeleteMessage } from "../projectDelete.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

interface Props {
    projects: Project[];
    /** Open tasks, for each project's count. */
    tasks: Task[];
    onOpen: (id: string) => void;
    onTogglePin: (id: string, pinned: boolean) => void;
    onDelete: (id: string) => void;
}

/** Every project in one list: pinned first, then A–Z, with a filter box. */
export function ProjectsView({ projects, tasks, onOpen, onTogglePin, onDelete }: Props) {
    const [query, setQuery] = useState("");
    const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return projects
            .filter((p) => !p.isInbox && (!q || p.name.toLowerCase().includes(q)))
            .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
    }, [projects, query]);

    const countOf = (id: string) => tasks.filter((t) => t.projectId === id).length;

    return (
        <div className="projects-view">
            <h1 className="view-title">Projects</h1>

            <input
                className="projects-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter projects"
                aria-label="Filter projects"
            />

            {rows.length === 0 ? (
                <p className="habit-empty projects-empty">
                    {query ? "No projects match." : "No projects yet. Add one with #name in a task."}
                </p>
            ) : (
                <ul className="projects-list">
                    {rows.map((p) => {
                        const n = countOf(p.id);
                        return (
                            <li key={p.id} className="projects-row">
                                <button className="projects-name" onClick={() => onOpen(p.id)}>
                                    <span>#{p.name}</span>
                                    {n > 0 && <span className="nav-count">{n}</span>}
                                </button>
                                <button
                                    className={`sort-toggle${p.pinned ? " is-on" : ""}`}
                                    onClick={() => onTogglePin(p.id, !p.pinned)}
                                    aria-pressed={p.pinned}
                                >
                                    {p.pinned ? "Pinned" : "Pin"}
                                </button>
                                <button className="sort-toggle" onClick={() => setPendingDelete(p)}>
                                    Delete
                                </button>
                            </li>
                        );
                    })}
                </ul>
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
