import { useMemo, useRef, useState } from "react";
import { parseQuickAdd } from "../../shared/parser.ts";
import type { Preferences } from "../api.ts";
import { formatDueLabel, priorityName } from "../format.ts";

interface Props {
  preferences: Preferences;
  onSubmit: (text: string) => Promise<void>;
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
export function QuickAdd({ preferences, onSubmit }: Props) {
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

  const segments = useMemo(() => buildSegments(text, parsed.tokens), [text, parsed.tokens]);
  const hasHints =
    parsed.due || parsed.projectName || parsed.labels.length > 0 ||
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
        <span className="qa-plus" aria-hidden="true">
          +
        </span>

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
            placeholder="Design review #Work @deep p1 every other tuesday at 3pm"
            aria-label="Add a task"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <button className="qa-submit" type="submit" disabled={!text.trim() || busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>

      {hasHints && (
        <div className="qa-preview">
          <span className="qa-preview-label">{parsed.content || "…"}</span>
          {parsed.due && (
            <span className="pill pill-date">{formatDueLabel(parsed.due)}</span>
          )}
          {parsed.deadline && (
            <span className="pill pill-deadline">due {parsed.deadline}</span>
          )}
          {parsed.durationMinutes && (
            <span className="pill">{formatDuration(parsed.durationMinutes)}</span>
          )}
          {parsed.projectName && (
            <span className="pill pill-project">#{parsed.projectName}</span>
          )}
          {parsed.labels.map((label) => (
            <span key={label} className="pill pill-label">
              @{label}
            </span>
          ))}
          {parsed.priority !== 4 && (
            <span className="pill pill-priority" data-p={parsed.priority}>
              {priorityName(parsed.priority)}
            </span>
          )}
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

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
