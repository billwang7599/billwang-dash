import { useEffect, useState } from "react";
import type { Project, Trash as TrashContents } from "../../shared/types.ts";
import { api } from "../api.ts";
import { optimistically } from "../optimistic.ts";
import { cardColor } from "../projectColors.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Hero } from "./Hero.tsx";

interface Props {
    projects: Project[];
    revision: number;
    /** Restoring brings projects and tasks back, so the app state must reload. */
    onChanged: () => void;
    /** Back to Settings, where this page is linked from. */
    onBack: () => void;
}

type Pending =
    | { kind: "project"; id: string; name: string }
    | { kind: "task"; id: string; name: string }
    | { kind: "all" };

type Rows = { kind: "project" | "task"; id: string } | { kind: "all" };

const without = (trash: TrashContents, rows: Rows): TrashContents =>
    rows.kind === "all"
        ? { projects: [], tasks: [] }
        : rows.kind === "project"
          ? { ...trash, projects: trash.projects.filter((p) => p.id !== rows.id) }
          : { ...trash, tasks: trash.tasks.filter((t) => t.id !== rows.id) };

export function Trash({ projects, revision, onChanged, onBack }: Props) {
    const [trash, setTrash] = useState<TrashContents | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);

    useEffect(() => {
        let stale = false;
        api.getTrash()
            .then((t) => !stale && setTrash(t))
            .catch((e: Error) => !stale && setError(e.message));
        return () => {
            stale = true;
        };
    }, [revision]);

    function act(rows: Rows, save: () => Promise<unknown>) {
        const before = trash;
        setTrash((t) => t && without(t, rows));
        optimistically(save, onChanged, () => setTrash(before), setError);
    }

    function confirmPending() {
        const p = pending;
        setPending(null);
        if (!p) return;
        if (p.kind === "project") act(p, () => api.purgeTrashedProject(p.id));
        else if (p.kind === "task") act(p, () => api.purgeTrashedTask(p.id));
        else act(p, () => api.emptyTrash());
    }

    const empty = trash !== null && trash.projects.length === 0 && trash.tasks.length === 0;

    return (
        <div className="trash">
            <div className="view-bar is-start">
                <button className="back-link" onClick={onBack}>
                    ← Settings
                </button>
                {trash && !empty && (
                    <button className="btn btn-quiet btn-quiet-danger" onClick={() => setPending({ kind: "all" })}>
                        Delete all
                    </button>
                )}
            </div>
            <Hero
                kicker="Kept until you clear them"
                title="Recently deleted"
                stats={
                    trash
                        ? [
                              { value: trash.projects.length, label: "projects" },
                              { value: trash.tasks.length, label: "tasks" },
                          ]
                        : []
                }
            />

            {error && <p className="banner banner-bad">{error}</p>}
            {trash === null && !error && <p className="trash-empty">Loading…</p>}
            {empty && <p className="trash-empty">Nothing recently deleted.</p>}

            {trash && trash.projects.length > 0 && (
                <section className="trash-section">
                    <h2 className="group-head">
                        Projects <span className="group-count">{trash.projects.length}</span>
                    </h2>
                    {/* A deleted project has no place in the order any more, so it's coloured by its place here. */}
                    <div className="stack">
                        {trash.projects.map((p, i) => (
                            <div key={p.id} className="tcard trash-row" style={{ ["--card-c" as string]: cardColor(i) }}>
                                <div className="trash-info">
                                    <span className="trash-name">{p.name}</span>
                                    <span className="trash-meta">
                                        Deleted {formatWhen(p.deletedAt)} · {p.taskCount} task
                                        {p.taskCount === 1 ? "" : "s"} went with it
                                    </span>
                                </div>
                                <div className="trash-actions">
                                    <button
                                        className="btn btn-quiet"
                                        disabled={nameTaken(projects, p.name)}
                                        title={
                                            nameTaken(projects, p.name)
                                                ? "A project with this name already exists"
                                                : undefined
                                        }
                                        onClick={() => act({ kind: "project", id: p.id }, () => api.restoreTrashedProject(p.id))}
                                    >
                                        Restore
                                    </button>
                                    <button
                                        className="btn btn-quiet btn-quiet-danger"
                                        onClick={() => setPending({ kind: "project", id: p.id, name: p.name })}
                                    >
                                        Delete forever
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {trash && trash.tasks.length > 0 && (
                <section className="trash-section">
                    <h2 className="group-head">
                        Tasks <span className="group-count">{trash.tasks.length}</span>
                    </h2>
                    <ul className="trash-list log-card">
                        {trash.tasks.map((t) => (
                            <li key={t.id} className="trash-row">
                                <div className="trash-info">
                                    <span className="trash-name">{t.content}</span>
                                    <span className="trash-meta">
                                        {projectName(projects, t.projectId)}deleted {formatWhen(t.deletedAt)}
                                    </span>
                                </div>
                                <div className="trash-actions">
                                    <button
                                        className="btn btn-quiet"
                                        onClick={() => act({ kind: "task", id: t.id }, () => api.restoreTrashedTask(t.id))}
                                    >
                                        Restore
                                    </button>
                                    <button
                                        className="btn btn-quiet btn-quiet-danger"
                                        onClick={() => setPending({ kind: "task", id: t.id, name: t.content })}
                                    >
                                        Delete forever
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {pending && (
                <ConfirmDialog
                    title={pending.kind === "all" ? "Delete everything here?" : "Delete forever?"}
                    message={
                        pending.kind === "all"
                            ? "Everything in Recently deleted will be permanently deleted. This can't be undone."
                            : pending.kind === "project"
                              ? `"${pending.name}" and its tasks will be permanently deleted. This can't be undone.`
                              : `"${pending.name}" will be permanently deleted. This can't be undone.`
                    }
                    confirmLabel={pending.kind === "all" ? "Delete all" : "Delete forever"}
                    onConfirm={confirmPending}
                    onCancel={() => setPending(null)}
                />
            )}
        </div>
    );
}

/** Mirrors the server's rule: a project can't come back if a live one has its name. */
function nameTaken(projects: Project[], name: string): boolean {
    return projects.some((p) => p.name.toLowerCase() === name.toLowerCase());
}

function projectName(projects: Project[], id: string): string {
    const p = projects.find((x) => x.id === id);
    return p && !p.isInbox ? `${p.name} · ` : "";
}

function formatWhen(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
