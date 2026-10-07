import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Approval, ChatMessage, PendingAction } from "../../shared/chat.ts";
import { api } from "../api.ts";

interface Props {
    /** A change the user approved went through; the rest of the app should reload. */
    onChanged: () => void;
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
export function AssistantView({ onChanged }: Props) {
    const chat = useSyncExternalStore(subscribe, () => chatState);
    const { busy, sending, error } = chat;
    const [draft, setDraft] = useState("");
    const [decisions, setDecisions] = useState<Record<string, boolean>>({});
    const endRef = useRef<HTMLDivElement>(null);

    useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [chat]);

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

    const shown = chat.messages.filter(
        (m): m is Extract<ChatMessage, { role: "user" | "assistant" }> =>
            m.role === "user" || (m.role === "assistant" && !!m.content?.trim()),
    );
    const empty = shown.length === 0 && !sending;

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
            <h1 className="view-title">Assistant</h1>

            <div className="chat" aria-live="polite">
                {empty && (
                    <div className="chat-empty">
                        <p>Ask about your tasks, calendar, habits or goals, or tell it what to change. You approve every change before it happens.</p>
                        <div className="chat-suggestions">
                            {SUGGESTIONS.map((s) => (
                                <button key={s} className="btn btn-quiet" onClick={() => send(s)}>
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {shown.map((m, i) => (
                    <p key={i} className={`chat-msg chat-${m.role}`}>
                        {m.content}
                    </p>
                ))}
                {sending && <p className="chat-msg chat-user">{sending}</p>}
                {busy && <p className="chat-msg chat-assistant chat-thinking">Thinking…</p>}

                {!busy && chat.pending.length > 0 && (
                    <div className="chat-pending">
                        {chat.pending.map((p) => (
                            <div key={p.toolCallId} className="chat-action">
                                <span className="chat-action-text">{p.summary}</span>
                                {p.toolCallId in decisions ? (
                                    <span className="chat-action-state">{decisions[p.toolCallId] ? "Approved" : "Declined"}</span>
                                ) : (
                                    <span className="chat-action-buttons">
                                        <button className="btn btn-quiet" onClick={() => decide(p.toolCallId, false)}>
                                            Decline
                                        </button>
                                        <button className="btn btn-primary" onClick={() => decide(p.toolCallId, true)}>
                                            Approve
                                        </button>
                                    </span>
                                )}
                            </div>
                        ))}
                        {chat.pending.length > 1 && Object.keys(decisions).length === 0 && (
                            <div className="chat-action-all">
                                <button className="btn btn-quiet" onClick={() => decideAll(false)}>
                                    Decline all
                                </button>
                                <button className="btn btn-primary" onClick={() => decideAll(true)}>
                                    Approve all
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {error && <p className="chat-error" role="alert">{error}</p>}
                <div ref={endRef} />
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
