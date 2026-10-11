import type { CalEvent, Task } from "./types.ts";

/**
 * Search matching, shared so the Worker's global search and the project page's filter
 * agree on what matches and on how a match is reported: which field it was in, and a
 * short excerpt with the hit marked, for the UI to highlight.
 */

export interface SearchField {
    /** What the user sees on the tag: "title", "notes", "day note"... The first field is the headline. */
    label: string;
    text: string;
}

export interface SearchMatch {
    /** The first field the query was found in. */
    field: string;
    /** How many other fields matched too. */
    more: number;
    /** The field's text, or an excerpt of it around the hit when it's long. */
    text: string;
    /** The hit within `text`, as a [start, end) range. */
    start: number;
    end: number;
}

export type SearchResult =
    | { kind: "task"; task: Task; match: SearchMatch }
    | { kind: "event"; event: CalEvent; match: SearchMatch }
    /** `day` is set when the hit was in that day's check-in note. */
    | { kind: "habit"; id: string; name: string; day: string | null; match: SearchMatch };

export interface SearchResults {
    tasks: SearchResult[];
    events: SearchResult[];
    habits: SearchResult[];
}

/** The most results of each kind the server sends. */
export const MAX_RESULTS_PER_KIND = 20;

const EXCERPT_AROUND = 40;

/** Case-insensitive substring search; null when nothing matches or the query is blank. */
export function matchFields(query: string, fields: SearchField[]): SearchMatch | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hits = fields.flatMap((f) => {
        const at = f.text.toLowerCase().indexOf(q);
        return at < 0 ? [] : [{ field: f, at }];
    });
    if (hits.length === 0) return null;

    const { field, at } = hits[0];
    const from = Math.max(0, at - EXCERPT_AROUND);
    const to = Math.min(field.text.length, at + q.length + EXCERPT_AROUND);
    const cut = field.text.length > 2 * EXCERPT_AROUND + q.length;
    const lead = cut && from > 0 ? "…" : "";
    const body = cut ? field.text.slice(from, to) : field.text;
    const offset = cut ? at - from : at;
    return {
        field: field.label,
        more: hits.length - 1,
        text: `${lead}${body}${cut && to < field.text.length ? "…" : ""}`,
        start: lead.length + offset,
        end: lead.length + offset + q.length,
    };
}
