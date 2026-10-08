/**
 * The assistant's wire format, shared by worker/ai/ and the chat view. Messages
 * follow the OpenAI chat shape Workers AI speaks, so history round-trips through
 * the browser unchanged. The system prompt is never part of it: the server adds
 * it fresh on every request.
 */

import type { Priority } from "./types.ts";

export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export type ChatMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

/**
 * A write, described for the approval card and, once it has run, the receipt. It
 * also rides along in the write's tool result, so the receipt can be drawn from
 * history alone.
 */
export interface ActionSummary {
    /** What the change does, e.g. "Add to calendar". */
    action: string;
    /** The same once done, e.g. "Added to calendar". */
    done: string;
    /** What it changes, e.g. "Make dinner". */
    title: string;
    /** When or how, e.g. "Sun, 11 Oct 2026 · 5pm–6pm". */
    detail?: string;
}

/** A write the model asked for, waiting on the user. */
export interface PendingAction {
    toolCallId: string;
    name: string;
    summary: ActionSummary;
}

/** A task as the show_tasks tool hands it to the chat, to draw as a card row. */
export interface ShownTask {
    id: string;
    content: string;
    projectId: string;
    priority: Priority;
    due: { date: string; time: string | null; recurring: boolean } | null;
    deadline?: string;
    completed?: boolean;
}

/** The tool whose results the chat draws as task cards. */
export const SHOW_TASKS = "show_tasks";

export interface Approval {
    toolCallId: string;
    approved: boolean;
}

export interface ChatReply {
    messages: ChatMessage[];
    pending: PendingAction[];
    /** True if a write ran during this request, so the app should reload. */
    changed: boolean;
}
