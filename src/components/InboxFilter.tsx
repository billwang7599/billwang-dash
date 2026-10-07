import type { Goal } from "../../shared/goals.ts";
import type { Project } from "../../shared/types.ts";
import { usePopover } from "../usePopover.ts";

export interface InboxHidden {
    projects: string[];
    goals: string[];
}

interface Props {
    projects: Project[];
    /** The goals worth offering: open ones, and finished ones that still have steps. */
    goals: Goal[];
    /** Ids left out. Stored this way round so a new project or goal shows by default. */
    hidden: InboxHidden;
    onChange: (hidden: InboxHidden) => void;
}

/**
 * "Filter ▾" button with a checklist of projects and goals, for choosing what
 * the Inbox shows. A task shows when its project is ticked and, if it's a step,
 * its goal is too.
 */
export function InboxFilter({ projects, goals, hidden, onChange }: Props) {
    const { open, setOpen, ref: rootRef } = usePopover<HTMLDivElement>();

    // Inbox first, then A–Z, like the sidebar's default.
    const orderedProjects = [...projects].sort((a, b) =>
        a.isInbox === b.isInbox ? a.name.localeCompare(b.name) : a.isInbox ? -1 : 1,
    );
    // Ids of deleted projects or goals can linger in the preference; only live ones count.
    const hiddenCount =
        orderedProjects.filter((p) => hidden.projects.includes(p.id)).length +
        goals.filter((g) => hidden.goals.includes(g.id)).length;
    const total = orderedProjects.length + goals.length;

    const toggle = (key: keyof InboxHidden, id: string) => {
        const list = hidden[key];
        onChange({ ...hidden, [key]: list.includes(id) ? list.filter((h) => h !== id) : [...list, id] });
    };

    return (
        <div className="pf" ref={rootRef}>
            <button
                className={`pf-button${hiddenCount > 0 ? " is-filtered" : ""}`}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={open}
            >
                Filter{hiddenCount > 0 && ` · ${hiddenCount} hidden`} <span aria-hidden="true">▾</span>
            </button>

            {open && (
                <div className="pf-menu" role="group" aria-label="What the Inbox shows">
                    <p className="pf-head">Projects</p>
                    {orderedProjects.map((p) => (
                        <label key={p.id} className="pf-option">
                            <input
                                type="checkbox"
                                checked={!hidden.projects.includes(p.id)}
                                onChange={() => toggle("projects", p.id)}
                            />
                            <span>{p.name}</span>
                        </label>
                    ))}

                    {goals.length > 0 && (
                        <>
                            <p className="pf-head">Goals</p>
                            {goals.map((g) => (
                                <label key={g.id} className="pf-option">
                                    <input
                                        type="checkbox"
                                        checked={!hidden.goals.includes(g.id)}
                                        onChange={() => toggle("goals", g.id)}
                                    />
                                    <span>◎ {g.title}</span>
                                </label>
                            ))}
                        </>
                    )}

                    <div className="pf-foot">
                        <button
                            className="sort-toggle"
                            onClick={() => onChange({ projects: [], goals: [] })}
                            disabled={hiddenCount === 0}
                        >
                            Show all
                        </button>
                        <button
                            className="sort-toggle"
                            onClick={() =>
                                onChange({ projects: orderedProjects.map((p) => p.id), goals: goals.map((g) => g.id) })
                            }
                            disabled={hiddenCount === total}
                        >
                            None
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
