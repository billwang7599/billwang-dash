import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchMatch, SearchResult, SearchResults } from "../../shared/search.ts";
import type { CalEvent, Project, Task } from "../../shared/types.ts";
import { api } from "../api.ts";
import { formatPlainDate } from "../format.ts";
import { cardColor } from "../projectColors.ts";
import { useDismiss } from "../useDismiss.ts";
import { Highlight, MatchSnippet, MatchTag } from "./MatchTag.tsx";
import { Modal } from "./Modal.tsx";
import { KindIcon, type ResultKind } from "./SearchIcons.tsx";

interface Props {
    projects: Project[];
    /** Project names are matched here, instantly; everything else is asked of the server. */
    onOpenProject: (project: Project) => void;
    onOpenTask: (task: Task) => void;
    onOpenEvent: (event: CalEvent) => void;
    onOpenHabit: (id: string, day: string | null) => void;
    onClose: () => void;
}

interface Row {
    key: string;
    title: string;
    /** Right-hand context: the project, the date. */
    meta?: string;
    match?: SearchMatch;
    open: () => void;
}

interface Group {
    label: string;
    kind: ResultKind;
    rows: Row[];
}

const DEBOUNCE_MS = 150;

/**
 * ⌘K: one box over projects, tasks, events and habits. Projects match as you type;
 * the rest come from /api/search a beat after you stop. Each row says which field the
 * query hit, and shows an excerpt when it wasn't the title.
 */
export function GlobalSearch({ projects, onOpenProject, onOpenTask, onOpenEvent, onOpenHabit, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<SearchResults | null>(null);
    const [failed, setFailed] = useState(false);
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => inputRef.current?.focus(), []);

    const q = query.trim();
    useEffect(() => {
        setFailed(false);
        if (!q) return setFound(null);
        const ctl = new AbortController();
        const timer = setTimeout(() => {
            api.search(q, ctl.signal)
                .then(setFound)
                .catch((e: Error) => e.name !== "AbortError" && setFailed(true));
        }, DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            ctl.abort();
        };
    }, [q]);

    const projectName = (id: string) => projects.find((p) => p.id === id)?.name;
    const groups = useMemo<Group[]>(() => {
        const act = (fn: () => void) => () => {
            close();
            fn();
        };
        const lower = q.toLowerCase();
        const matchedProjects = q ? projects.filter((p) => p.name.toLowerCase().includes(lower)) : projects;
        const out: Group[] = [
            {
                label: "Projects",
                kind: "project",
                rows: matchedProjects.map((p) => ({ key: `p:${p.id}`, title: p.name, open: act(() => onOpenProject(p)) })),
            },
        ];
        const fromServer = (key: keyof SearchResults, label: string, kind: ResultKind, row: (r: SearchResult) => Row) =>
            out.push({ label, kind, rows: (found?.[key] ?? []).map(row) });
        if (q) {
            fromServer("tasks", "Tasks", "task", (r) => {
                const task = (r as Extract<SearchResult, { kind: "task" }>).task;
                return {
                    key: `t:${task.id}`,
                    title: task.content,
                    meta: [task.completed ? "done" : null, projectName(task.projectId)].filter(Boolean).join(" · "),
                    match: r.match,
                    open: act(() => onOpenTask(task)),
                };
            });
            fromServer("events", "Events", "event", (r) => {
                const event = (r as Extract<SearchResult, { kind: "event" }>).event;
                return {
                    key: `e:${event.id}`,
                    title: event.title,
                    meta: formatPlainDate(event.startDate),
                    match: r.match,
                    open: act(() => onOpenEvent(event)),
                };
            });
            fromServer("habits", "Habits", "habit", (r) => {
                const habit = r as Extract<SearchResult, { kind: "habit" }>;
                return {
                    key: `h:${habit.id}`,
                    title: habit.name,
                    meta: habit.day ? formatPlainDate(habit.day) : undefined,
                    match: habit.match,
                    open: act(() => onOpenHabit(habit.id, habit.day)),
                };
            });
        }
        return out.filter((g) => g.rows.length > 0);
        // projectName only reads `projects`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q, projects, found]);

    const rows = groups.flatMap((g) => g.rows);
    useEffect(() => setActive(0), [q, found]);

    function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (rows.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
        } else if (e.key === "Enter") {
            e.preventDefault();
            rows[active]?.open();
        }
    }

    useEffect(() => {
        document.querySelector(".search-result.is-active")?.scrollIntoView({ block: "nearest" });
    }, [active, rows.length]);

    let index = -1;
    return (
        <Modal label="Search" className="search-modal" closing={closing} onClose={close}>
            <div className="search-head">
                <input
                    ref={inputRef}
                    className="modal-title"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search tasks, events, habits, projects…"
                    aria-label="Search"
                />
                {q && found && (
                    <span className="search-count">{rows.length === 1 ? "1 result" : `${rows.length} results`}</span>
                )}
            </div>

            <div className="search-results">
                {groups.map((g, gi) => (
                    <section key={g.label} className="search-group" style={{ ["--card-c" as string]: cardColor(gi) }}>
                        <h4 className="search-group-head">
                            {g.label}
                            <span>{g.rows.length}</span>
                        </h4>
                        <ul className="search-list">
                            {g.rows.map((r) => {
                                index += 1;
                                const i = index;
                                return (
                                    <li key={r.key}>
                                        <button
                                            className={`search-result${i === active ? " is-active" : ""}`}
                                            onClick={r.open}
                                            onMouseMove={() => setActive(i)}
                                        >
                                            <span className="search-icon-tile">
                                                <KindIcon kind={g.kind} />
                                            </span>
                                            <span className="search-text">
                                                <span className="search-line">
                                                    <span className="search-title">
                                                        {r.match?.field === "title" ? (
                                                            <Highlight text={r.match.text} start={r.match.start} end={r.match.end} />
                                                        ) : (
                                                            r.title
                                                        )}
                                                    </span>
                                                    {r.match && <MatchTag match={r.match} />}
                                                    {r.meta && <span className="search-meta">{r.meta}</span>}
                                                </span>
                                                {r.match && <MatchSnippet match={r.match} />}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ))}
                {rows.length === 0 && (
                    <p className="search-empty">
                        {failed ? "Search failed. Try again." : q && !found ? "Searching…" : "Nothing matches."}
                    </p>
                )}
            </div>
        </Modal>
    );
}
