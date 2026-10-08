import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    SHOW_TASKS,
    type ActionSummary,
    type Approval,
    type ChatMessage,
    type PendingAction,
    type ShownTask,
} from "../../shared/chat.ts";
import { api } from "../api.ts";
import { formatDateLabel, formatTime } from "../format.ts";
import { cardColor } from "../projectColors.ts";
import { Hero } from "./Hero.tsx";

interface Props {
    timeZone: string;
    /** Today in the user's zone, YYYY-MM-DD, to sort shown tasks into Overdue, Today and later. */
    today: string;
    /** A change the user approved went through; the rest of the app should reload. */
    onChanged: () => void;
    /** A task on an answer card was clicked; the parent opens its editor. */
    onOpenTask: (taskId: string) => void;
}

interface Saved {
    messages: ChatMessage[];
    pending: PendingAction[];
}

// Session storage, so the chat survives a reload but not closing the tab.
const STORAGE_KEY = "dash.assistant";

function load(): Saved {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw) as Saved;
    } catch {
        // Blocked or corrupt storage just means a fresh chat.
    }
    return { messages: [], pending: [] };
}

function save(saved: Saved) {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
        // Best effort, as above.
    }
}

/**
 * The chat lives out here rather than in component state because each view
 * remounts on navigation. A reply that lands after the user has left the page
 * still updates the chat, so coming back shows the outcome instead of the same
 * approval cards again. (The server refuses to run an approved call twice
 * anyway; see worker/do/ai-runs.ts.)
 */
interface ChatState extends Saved {
    busy: boolean;
    /** The user's message while the request runs, shown before the reply lands. */
    sending: string | null;
    error: string | null;
}

let chatState: ChatState = { ...load(), busy: false, sending: null, error: null };
const listeners = new Set<() => void>();

function update(patch: Partial<ChatState>) {
    chatState = { ...chatState, ...patch };
    if ("messages" in patch || "pending" in patch) save({ messages: chatState.messages, pending: chatState.pending });
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

async function request(messages: ChatMessage[], approvals: Approval[] | undefined, onChanged: () => void) {
    update({ busy: true, error: null });
    try {
        const reply = await api.chat({ messages, approvals });
        update({ messages: reply.messages, pending: reply.pending, busy: false, sending: null });
        if (reply.changed) onChanged();
        return true;
    } catch (e) {
        update({ error: (e as Error).message, busy: false, sending: null });
        return false;
    }
}

const SUGGESTIONS = ["What's due this week?", "How are my habits going this month?", "Which goals am I behind on?"];

/**
 * Chat with the assistant in worker/ai/. It can read anything, but each change
 * it wants to make shows up as a card the user approves or declines first.
 */
export function AssistantView({ timeZone, today, onChanged, onOpenTask }: Props) {
    const chat = useSyncExternalStore(subscribe, () => chatState);
    const { busy, sending, error } = chat;
    const [draft, setDraft] = useState("");
    const [decisions, setDecisions] = useState<Record<string, boolean>>({});
    const mounted = useRef(false);

    // Newest at the bottom, like any chat: jump there on arrival, glide for new turns.
    // A block body on purpose: Chrome's scroll methods now return a Promise, and an
    // effect that returns one crashes React when the view unmounts.
    useEffect(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: mounted.current ? "smooth" : "instant" });
        mounted.current = true;
    }, [chat]);

    async function send(text: string) {
        const content = text.trim();
        if (!content || busy) return;
        setDraft("");
        update({ sending: content });
        // Typing past open cards declines them; the server answers those calls.
        const ok = await request([...chat.messages, { role: "user", content }], undefined, onChanged);
        if (!ok) setDraft(content);
    }

    function decide(toolCallId: string, approved: boolean) {
        const next = { ...decisions, [toolCallId]: approved };
        setDecisions(next);
        if (chat.pending.every((p) => p.toolCallId in next)) submit(next);
    }

    function decideAll(approved: boolean) {
        submit(Object.fromEntries(chat.pending.map((p) => [p.toolCallId, approved])));
    }

    async function submit(all: Record<string, boolean>) {
        await request(
            chat.messages,
            Object.entries(all).map(([toolCallId, approved]) => ({ toolCallId, approved })),
            onChanged,
        );
        // Cleared on failure too, so the cards can be answered again.
        setDecisions({});
    }

    const turns = toTurns(chat.messages);
    const empty = turns.length === 0 && !sending;

    return (
        <>
            <div className="view-bar">
                {!empty && (
                    <button
                        className="btn btn-quiet"
                        disabled={busy}
                        onClick={() => update({ messages: [], pending: [], error: null })}
                    >
                        New chat
                    </button>
                )}
            </div>
            <Hero kicker="Ask about anything in your dash" title="Assistant" accent="var(--c-lav)" />

            <div className="chat" aria-live="polite">
                {empty && (
                    <>
                        <p className="chat-intro">
                            Ask about your tasks, calendar, habits or goals, or tell it what to change. Nothing changes
                            until you approve it.
                        </p>
                        <div className="chat-suggestions">
                            {SUGGESTIONS.map((s, i) => (
                                <button
                                    key={s}
                                    className="chat-suggestion"
                                    style={{ "--card-c": cardColor(i) } as React.CSSProperties}
                                    onClick={() => send(s)}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </>
                )}

                {turns.map((turn, i) => (
                    <Fragment key={i}>
                        {turn.question !== null && <p className="chat-q">{turn.question}</p>}
                        {turn.replies.map((text, j) => (
                            <p key={j} className="chat-a">
                                {text}
                            </p>
                        ))}
                        {turn.attachments.map((a) =>
                            a.kind === "tasks" ? (
                                <TaskCards
                                    key={a.key}
                                    tasks={a.tasks}
                                    timeZone={timeZone}
                                    today={today}
                                    onOpen={onOpenTask}
                                />
                            ) : (
                                <Receipt key={a.key} summary={a.summary} />
                            ),
                        )}
                    </Fragment>
                ))}
                {sending && <p className="chat-q">{sending}</p>}
                {busy && (
                    <p className="chat-a chat-thinking" role="status" aria-label="Thinking">
                        <span className="chat-dot" />
                        <span className="chat-dot" />
                        <span className="chat-dot" />
                    </p>
                )}

                {!busy &&
                    chat.pending.map((p) => (
                        <div key={p.toolCallId} className="chat-action">
                            <p className="chat-action-kicker">Needs your OK · {p.summary.action}</p>
                            <p className="chat-action-text">{p.summary.title}</p>
                            {p.summary.detail && <p className="chat-action-detail">{p.summary.detail}</p>}
                            {p.toolCallId in decisions ? (
                                <p className="chat-action-state">{decisions[p.toolCallId] ? "Approved" : "Declined"}</p>
                            ) : (
                                <div className="chat-action-buttons">
                                    <button className="btn btn-quiet" onClick={() => decide(p.toolCallId, false)}>
                                        Decline
                                    </button>
                                    <button className="btn btn-primary" onClick={() => decide(p.toolCallId, true)}>
                                        Approve
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                {!busy && chat.pending.length > 1 && Object.keys(decisions).length === 0 && (
                    <div className="chat-action-all">
                        <button className="btn btn-quiet" onClick={() => decideAll(false)}>
                            Decline all
                        </button>
                        <button className="btn btn-primary" onClick={() => decideAll(true)}>
                            Approve all
                        </button>
                    </div>
                )}

                {error && (
                    <p className="chat-error" role="alert">
                        {error}
                    </p>
                )}
            </div>

            <div className="qa-dock">
                <form
                    className="quickadd chat-composer"
                    onSubmit={(e) => {
                        e.preventDefault();
                        send(draft);
                    }}
                >
                    <input
                        className="chat-input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={chat.pending.length ? "Or say what to do instead…" : "Ask or tell the assistant…"}
                        aria-label="Message the assistant"
                        maxLength={4000}
                        autoFocus
                    />
                    <button className="btn btn-primary" type="submit" disabled={busy || !draft.trim()}>
                        Send
                    </button>
                </form>
            </div>
        </>
    );
}

/** One question and everything that answered it: the words, then the cards. */
interface Turn {
    /** Null only for a reply with no question before it, which a fresh chat never has. */
    question: string | null;
    replies: string[];
    attachments: Attachment[];
}

type Attachment =
    | { kind: "tasks"; key: string; tasks: ShownTask[] }
    | { kind: "receipt"; key: string; summary: ActionSummary };

/**
 * Splits the history into turns. Cards come from tool results rather than the model's
 * text: show_tasks results become task cards, and a write that ran becomes a receipt.
 * Within a turn the words go first and the cards under them, whatever order they came in.
 */
function toTurns(messages: ChatMessage[]): Turn[] {
    const toolNames = new Map<string, string>();
    const turns: Turn[] = [];
    const current = () => {
        if (turns.length === 0) turns.push({ question: null, replies: [], attachments: [] });
        return turns[turns.length - 1];
    };
    for (const m of messages) {
        if (m.role === "user") {
            turns.push({ question: m.content, replies: [], attachments: [] });
        } else if (m.role === "assistant") {
            for (const call of m.tool_calls ?? []) toolNames.set(call.id, call.function.name);
            if (m.content?.trim()) current().replies.push(m.content);
        } else {
            const attachment = toAttachment(toolNames.get(m.tool_call_id), m.tool_call_id, m.content);
            if (attachment) current().attachments.push(attachment);
        }
    }
    return turns;
}

function toAttachment(toolName: string | undefined, key: string, content: string): Attachment | null {
    let body: { result?: { tasks?: ShownTask[] }; summary?: ActionSummary; error?: unknown };
    try {
        body = JSON.parse(content);
    } catch {
        return null; // cut short at the server's size cap; the reply's words still say what happened
    }
    if (body.error !== undefined) return null;
    if (toolName === SHOW_TASKS) {
        const tasks = body.result?.tasks;
        return tasks?.length ? { kind: "tasks", key, tasks } : null;
    }
    return body.summary ? { kind: "receipt", key, summary: body.summary } : null;
}

/** Colour means when: overdue is terra, today mustard, later sky, undated stone. */
const GROUPS = [
    { key: "overdue", label: "Overdue", color: "var(--c-terra)" },
    { key: "today", label: "Today", color: "var(--c-mustard)" },
    { key: "later", label: "Coming up", color: "var(--c-sky)" },
    { key: "none", label: "No date", color: "var(--c-stone)" },
] as const;

function groupOf(task: ShownTask, today: string): (typeof GROUPS)[number]["key"] {
    if (!task.due) return "none";
    return task.due.date < today ? "overdue" : task.due.date === today ? "today" : "later";
}

const dueSortKey = (t: ShownTask) => (t.due ? `${t.due.date} ${t.due.time ?? ""}` : "");

/** Tasks the assistant answered with, as a stack of date cards like the Inbox's. */
function TaskCards({
    tasks,
    timeZone,
    today,
    onOpen,
}: {
    tasks: ShownTask[];
    timeZone: string;
    today: string;
    onOpen: (id: string) => void;
}) {
    const sorted = [...tasks].sort((a, b) => dueSortKey(a).localeCompare(dueSortKey(b)));
    const groups = GROUPS.map((g) => ({ ...g, tasks: sorted.filter((t) => groupOf(t, today) === g.key) })).filter(
        (g) => g.tasks.length > 0,
    );
    // Today's card already says the day, so its rows only need a time.
    const when = (t: ShownTask, group: string) => {
        if (!t.due) return "";
        const time = t.due.time ? formatTime(t.due.time) : "";
        if (group === "today") return time;
        return [formatDateLabel(t.due.date, timeZone), time].filter(Boolean).join(" ");
    };
    return (
        <div className="stack chat-cards">
            {groups.map((g) => (
                <section key={g.key} className="tcard" style={{ "--card-c": g.color } as React.CSSProperties}>
                    <h3 className="tcard-head">
                        {g.label}
                        <span>{g.tasks.length}</span>
                    </h3>
                    {g.tasks.map((t) => (
                        <button
                            key={t.id}
                            className={`chat-task${t.completed ? " is-done" : ""}`}
                            onClick={() => onOpen(t.id)}
                        >
                            <span className="chat-task-title">{t.content}</span>
                            <span className="chat-task-when">{when(t, g.key)}</span>
                        </button>
                    ))}
                </section>
            ))}
        </div>
    );
}

/** A change that went through, as a small green card. */
function Receipt({ summary }: { summary: ActionSummary }) {
    return (
        <div className="chat-receipt">
            <div>
                <p className="chat-receipt-kicker">{summary.done}</p>
                <p className="chat-receipt-title">{summary.title}</p>
            </div>
            {summary.detail && <span className="chat-receipt-detail">{summary.detail}</span>}
        </div>
    );
}
