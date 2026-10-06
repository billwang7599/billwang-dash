/**
 * Bulk import: one task per line, each parsed with the quick-add grammar. The
 * UI previews with this and the Worker re-splits with it, so the two agree.
 */

export const MAX_IMPORT_LINES = 500;

/** Blank lines and leading list bullets ("- ", "* ", "• ") are ignored. */
export function splitImportLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*•]\s+/, "").trim())
        .filter(Boolean);
}
