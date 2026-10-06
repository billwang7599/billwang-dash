import type { ParsedQuickAdd } from "../../shared/types.ts";
import { formatDueLabel, priorityName } from "../format.ts";

interface Props {
    parsed: ParsedQuickAdd;
    timeZone: string;
    /** The "#project" doesn't exist yet, so adding this will create it. */
    isNewProject: boolean;
}

/** What the parser understood, as pills. Shared by quick-add and import. */
export function ParsedPills({ parsed, timeZone, isNewProject }: Props) {
    return (
        <>
            {parsed.due && (
                <span className="pill pill-date">{formatDueLabel(parsed.due, timeZone)}</span>
            )}
            {parsed.deadline && (
                <span className="pill pill-deadline">due {parsed.deadline}</span>
            )}
            {parsed.durationMinutes && (
                <span className="pill">{formatDuration(parsed.durationMinutes)}</span>
            )}
            {parsed.projectName && (
                <span className="pill pill-project">
                    #{parsed.projectName}
                    {isNewProject && " · new"}
                </span>
            )}
            {parsed.priority !== 4 && (
                <span className="pill pill-priority" data-p={parsed.priority}>
                    {priorityName(parsed.priority)}
                </span>
            )}
        </>
    );
}

function formatDuration(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
