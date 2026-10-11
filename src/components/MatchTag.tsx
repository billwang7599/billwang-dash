import type { SearchMatch } from "../../shared/search.ts";

/** `text` with the hit marked. */
export function Highlight({ text, start, end }: { text: string; start: number; end: number }) {
    return (
        <>
            {text.slice(0, start)}
            <mark className="hit">{text.slice(start, end)}</mark>
            {text.slice(end)}
        </>
    );
}

/**
 * The small pill saying which field a search matched in ("notes", "+1" when others matched too).
 * A plain title match needs no pill: the highlight in the title already says so.
 */
export const hasMatchTag = (match: SearchMatch) => match.field !== "title" || match.more > 0;

export function MatchTag({ match }: { match: SearchMatch }) {
    if (!hasMatchTag(match)) return null;
    return (
        <span className="chip match-tag" title={match.more ? `Also matched in ${match.more} other field${match.more > 1 ? "s" : ""}` : undefined}>
            {match.field}
            {match.more > 0 && ` +${match.more}`}
        </span>
    );
}

/** The excerpt line under a result; a title match is already highlighted in the title itself. */
export function MatchSnippet({ match }: { match: SearchMatch }) {
    if (match.field === "title") return null;
    return (
        <span className="match-snippet">
            <Highlight text={match.text} start={match.start} end={match.end} />
        </span>
    );
}
