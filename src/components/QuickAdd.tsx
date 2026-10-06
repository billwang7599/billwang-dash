import { useMemo, useRef, useState } from "react";
import { splitImportLines } from "../../shared/import.ts";
import { parseQuickAdd } from "../../shared/parser.ts";
import type { Preferences } from "../api.ts";
import type { Project } from "../../shared/types.ts";
import { ParsedPills } from "./ParsedPills.tsx";

interface Props {
    preferences: Preferences;
    projects: Project[];
    onSubmit: (text: string) => Promise<void>;
    /** Several lines were pasted: hand them to the bulk import instead. */
    onPasteMany: (text: string) => void;
    /** Phone layout: a short placeholder and a round ↑ button instead of "Add". */
    compact?: boolean;
}

/**
 * The quick-add bar.
 *
 * The parse runs on every keystroke using the same module the Worker uses, so
 * the preview can never promise something the server won't store. Highlighting
 * is a mirrored layer sitting exactly behind a transparent input — the input
 * keeps native caret, selection and IME behaviour, and the layer only paints
 * backgrounds.
 */
export function QuickAdd({ preferences, projects, onSubmit, onPasteMany, compact = false }: Props) {
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const parsed = useMemo(
        () =>
            parseQuickAdd(text, {
                timeZone: preferences.timeZone,
                dateFormat: preferences.dateFormat,
            }),
        [text, preferences.timeZone, preferences.dateFormat],
    );

    // The server files "#name" into an existing project case-insensitively and
    // creates one otherwise, so flag the case that would create one.
    const isNewProject =
        parsed.projectName !== null &&
        !projects.some((p) => p.name.toLowerCase() === parsed.projectName!.toLowerCase());

    const segments = useMemo(() => buildSegments(text, parsed.tokens), [text, parsed.tokens]);
    const hasHints =
        parsed.due || parsed.projectName ||
        parsed.priority !== 4 || parsed.durationMinutes || parsed.deadline;

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        const value = text.trim();
        if (!value || busy) return;

        setBusy(true);
        setError(null);
        try {
            await onSubmit(value);
            setText("");
            inputRef.current?.focus();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="quickadd" onSubmit={submit}>
            <div className="qa-field">
                <div className="qa-input-wrap">
                    <div className="qa-highlight" aria-hidden="true">
                        {segments.map((seg, i) =>
                            seg.type ? (
                                <mark key={i} className={`tok tok-${seg.type}`}>
                                    {seg.text}
                                </mark>
                            ) : (
                                <span key={i}>{seg.text}</span>
                            ),
                        )}
                    </div>

                    <input
                        ref={inputRef}
                        className="qa-input"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onPaste={(e) => {
                            // An <input> would flatten the newlines, so catch it first.
                            const pasted = e.clipboardData.getData("text");
                            if (splitImportLines(pasted).length > 1) {
                                e.preventDefault();
                                onPasteMany(pasted);
                            }
                        }}
                        placeholder={compact ? "Add a task…" : "Design review #Work p1 every other tuesday at 3pm"}
                        aria-label="Add a task"
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                <button
                    className={`qa-submit${compact ? " is-round" : ""}`}
                    type="submit"
                    disabled={!text.trim() || busy}
                    aria-label="Add task"
                >
                    {compact ? "↑" : busy ? "Adding…" : "Add"}
                </button>
            </div>

            {hasHints && (
                <div className="qa-preview">
                    <span className="qa-preview-label">{parsed.content || "…"}</span>
                    <ParsedPills
                        parsed={parsed}
                        timeZone={preferences.timeZone}
                        isNewProject={isNewProject}
                    />
                </div>
            )}

            {error && <p className="qa-error">{error}</p>}
        </form>
    );
}

interface Segment {
    text: string;
    type: string | null;
}

/** Splits the raw text into plain and highlighted runs. */
function buildSegments(
    raw: string,
    tokens: { start: number; end: number; type: string }[],
): Segment[] {
    const segments: Segment[] = [];
    let cursor = 0;

    for (const token of tokens) {
        if (token.start < cursor) continue; // defensive: tokens should not overlap
        if (token.start > cursor) {
            segments.push({ text: raw.slice(cursor, token.start), type: null });
        }
        segments.push({ text: raw.slice(token.start, token.end), type: token.type });
        cursor = token.end;
    }

    if (cursor < raw.length) segments.push({ text: raw.slice(cursor), type: null });
    return segments;
}
