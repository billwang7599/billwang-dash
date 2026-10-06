import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/types.ts";

interface Props {
    projects: Project[];
    /** Ids left out. Stored this way round so a new project shows by default. */
    hidden: string[];
    onChange: (hidden: string[]) => void;
}

/** "Projects: All ▾" button with a checklist, for choosing what the Inbox shows. */
export function ProjectFilter({ projects, hidden, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("mousedown", onDown);
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    // Inbox first, then A–Z, like the sidebar's default.
    const ordered = [...projects].sort((a, b) =>
        a.isInbox === b.isInbox ? a.name.localeCompare(b.name) : a.isInbox ? -1 : 1,
    );
    // Ids of deleted projects can linger in the preference; only live ones count.
    const shown = ordered.filter((p) => !hidden.includes(p.id)).length;
    const label = shown === ordered.length ? "All" : `${shown} of ${ordered.length}`;

    const toggle = (id: string) =>
        onChange(hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);

    return (
        <div className="pf" ref={rootRef}>
            <button
                className={`pf-button${shown < ordered.length ? " is-filtered" : ""}`}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={open}
            >
                Projects: {label} <span aria-hidden="true">▾</span>
            </button>

            {open && (
                <div className="pf-menu" role="group" aria-label="Projects to show">
                    {ordered.map((p) => (
                        <label key={p.id} className="pf-option">
                            <input type="checkbox" checked={!hidden.includes(p.id)} onChange={() => toggle(p.id)} />
                            <span>{p.name}</span>
                        </label>
                    ))}
                    <div className="pf-foot">
                        <button className="sort-toggle" onClick={() => onChange([])} disabled={shown === ordered.length}>
                            Show all
                        </button>
                        <button
                            className="sort-toggle"
                            onClick={() => onChange(ordered.map((p) => p.id))}
                            disabled={shown === 0}
                        >
                            None
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
