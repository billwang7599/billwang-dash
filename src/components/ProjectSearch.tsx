import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../shared/types.ts";

interface Props {
  projects: Project[];
  onSelect: (project: Project) => void;
  onClose: () => void;
}

export function ProjectSearch({ projects, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search projects"
        onMouseDown={(e) => e.stopPropagation()}
      >
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
      </div>
    </div>
  );
}
