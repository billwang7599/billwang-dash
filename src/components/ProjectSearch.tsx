import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../shared/types.ts";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";

interface Props {
    projects: Project[];
    onSelect: (project: Project) => void;
    onClose: () => void;
}

export function ProjectSearch({ projects, onSelect, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => inputRef.current?.focus(), []);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return projects;
        return projects.filter((p) => p.name.toLowerCase().includes(q));
    }, [projects, query]);

    function submit(e: React.FormEvent) {
        e.preventDefault();
        if (results[0]) onSelect(results[0]);
    }

    return (
        <Modal label="Search projects" className="search-modal" closing={closing} onClose={close}>
            <form onSubmit={submit}>
                <input
                    ref={inputRef}
                    className="modal-title"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search projects…"
                    aria-label="Search projects"
                />
            </form>

            <ul className="search-results">
                {results.length === 0 && <li className="search-empty">No projects match.</li>}
                {results.map((p) => (
                    <li key={p.id}>
                        <button className="search-result" onClick={() => onSelect(p)}>
                            {p.name}
                        </button>
                    </li>
                ))}
            </ul>
        </Modal>
    );
}
