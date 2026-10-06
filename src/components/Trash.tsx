import { useCallback, useEffect, useState } from "react";
import type { Project, Trash as TrashContents } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

interface Props {
    projects: Project[];
    /** Restoring brings projects and tasks back, so the app state must reload. */
    onChanged: () => void;
    /** Back to Settings, where this page is linked from. */
    onBack: () => void;
}

type Pending =
    | { kind: "project"; id: string; name: string }
    | { kind: "task"; id: string; name: string }
    | { kind: "all" };

export function Trash({ projects, onChanged, onBack }: Props) {
    const [trash, setTrash] = useState<TrashContents | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);

    useEffect(() => {
        api.getTrash().then(setTrash).catch((e: Error) => setError(e.message));
    }, []);

    /** Runs a mutation, then reloads the trash list and tells the app to reload. */
    const act = useCallback(
        async (fn: () => Promise<unknown>) => {
            setError(null);
            try {
                await fn();
                setTrash(await api.getTrash());
                onChanged();
            } catch (e) {
                setError((e as Error).message);
            }
        },
        [onChanged],
    );

    function confirmPending() {
        const p = pending;
        setPending(null);
        if (!p) return;
        if (p.kind === "project") void act(() => api.purgeTrashedProject(p.id));
        else if (p.kind === "task") void act(() => api.purgeTrashedTask(p.id));
        else void act(() => api.emptyTrash());
    }

    const empty = trash !== null && trash.projects.length === 0 && trash.tasks.length === 0;

    return (
        <div className="trash">
            <button className="trash-back sort-toggle" onClick={onBack}>
                ← Settings
            </button>
            <div className="trash-head">
                <h1 className="view-title">Recently deleted</h1>
                {trash && !empty && (
                    <button className="btn btn-quiet" onClick={() => setPending({ kind: "all" })}>
                        Delete all
                    </button>
                )}
            </div>

            {error && <p className="banner banner-bad">{error}</p>}
            {trash === null && !error && <p className="trash-empty">Loading…</p>}
            {empty && <p className="trash-empty">Nothing recently deleted.</p>}

            {trash && !empty && (
                <ul className="trash-list">
                    {trash.projects.map((p) => (
                        <li key={p.id} className="trash-row">
                            <div className="trash-info">
                                <span className="trash-name">#{p.name}</span>
                                <span className="trash-meta">
                                    project · {p.taskCount} task{p.taskCount === 1 ? "" : "s"} · deleted{" "}
                                    {formatWhen(p.deletedAt)}
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
                                    onClick={() => act(() => api.restoreTrashedProject(p.id))}
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
                        </li>
                    ))}
                    {trash.tasks.map((t) => (
                        <li key={t.id} className="trash-row">
                            <div className="trash-info">
                                <span className="trash-name">{t.content}</span>
                                <span className="trash-meta">
                                    task
                                    {projectName(projects, t.projectId)} · deleted {formatWhen(t.deletedAt)}
                                </span>
                            </div>
                            <div className="trash-actions">
                                <button
                                    className="btn btn-quiet"
                                    onClick={() => act(() => api.restoreTrashedTask(t.id))}
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
    return p && !p.isInbox ? ` · #${p.name}` : "";
}

function formatWhen(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
