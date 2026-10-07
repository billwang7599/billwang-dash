import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_IMPORT_LINES, splitImportLines } from "../../shared/import.ts";
import { parseQuickAdd } from "../../shared/parser.ts";
import type { Project } from "../../shared/types.ts";
import type { Preferences } from "../api.ts";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";
import { ParsedPills } from "./ParsedPills.tsx";

interface Props {
    /** What was pasted into the quick-add bar. */
    initialText: string;
    preferences: Preferences;
    projects: Project[];
    onImport: (text: string) => Promise<void>;
    onClose: () => void;
}

/**
 * Paste one task per line; each is parsed with the quick-add grammar and shown
 * before anything is created. The Worker re-parses on submit.
 */
export function ImportModal({ initialText, preferences, projects, onImport, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [text, setText] = useState(initialText);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => inputRef.current?.focus(), []);

    const rows = useMemo(() => {
        // The first "#name" in the batch creates the project, so later ones are not new.
        const known = new Set(projects.map((p) => p.name.toLowerCase()));
        return splitImportLines(text).map((line) => {
            const parsed = parseQuickAdd(line, {
                timeZone: preferences.timeZone,
                dateFormat: preferences.dateFormat,
            });
            const key = parsed.projectName?.toLowerCase();
            const isNewProject = key !== undefined && !known.has(key);
            if (key !== undefined) known.add(key);
            return { line, parsed, isNewProject };
        });
    }, [text, projects, preferences.timeZone, preferences.dateFormat]);

    const valid = rows.filter((r) => r.parsed.content);
    const skipped = rows.length - valid.length;
    const newProjects = valid.filter((r) => r.isNewProject).length;
    const tooMany = rows.length > MAX_IMPORT_LINES;
    const createLabel =
        valid.length === 0 ? "Create tasks" : `Create ${valid.length} task${valid.length === 1 ? "" : "s"}`;

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (valid.length === 0 || tooMany) return;
        setBusy(true);
        setError(null);
        try {
            await onImport(text);
            close();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <Modal label="Import tasks" className="import-modal" closing={closing} onClose={close}>
            <form onSubmit={submit}>
                <h2 className="modal-title">Import tasks</h2>
                <p className="modal-note">
                    One task per line, in quick-add syntax: <code>Pay rent #Home p1 every month</code>
                </p>

                <textarea
                    ref={inputRef}
                    className="modal-desc import-input"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={"Buy milk tomorrow\nReview specs #Work p1 friday at 3pm for 90m"}
                    aria-label="Tasks to import, one per line"
                    rows={6}
                />

                {rows.length > 0 && (
                    <>
                        <p className="import-summary">
                            {valid.length} task{valid.length === 1 ? "" : "s"} will be created
                            {newProjects > 0 && ` · ${newProjects} new project${newProjects === 1 ? "" : "s"}`}
                            {skipped > 0 && ` · ${skipped} skipped`}
                        </p>
                        <ul className="import-list">
                            {rows.map((r, i) => (
                                <li key={i} className={r.parsed.content ? "import-row" : "import-row is-skipped"}>
                                    {r.parsed.content ? (
                                        <>
                                            <span className="import-content">{r.parsed.content}</span>
                                            <ParsedPills
                                                parsed={r.parsed}
                                                timeZone={preferences.timeZone}
                                                isNewProject={r.isNewProject}
                                            />
                                        </>
                                    ) : (
                                        <span className="import-content">
                                            {r.line} <span className="pill">no content, skipped</span>
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                {tooMany && (
                    <p className="modal-error">At most {MAX_IMPORT_LINES} tasks per import.</p>
                )}
                {error && <p className="modal-error">{error}</p>}

                <div className="modal-actions">
                    <button type="button" className="btn btn-quiet" onClick={close}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={valid.length === 0 || tooMany || busy}
                    >
                        {busy ? "Importing…" : createLabel}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
