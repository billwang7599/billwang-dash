/**
 * The assistant's wire format, shared by worker/ai/ and the chat view. Messages
 * follow the OpenAI chat shape Workers AI speaks, so history round-trips through
 * the browser unchanged. The system prompt is never part of it: the server adds
 * it fresh on every request.
 */

export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export type ChatMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

/** A write the model asked for, waiting on the user. */
export interface PendingAction {
    toolCallId: string;
    name: string;
    /** One line for the approval card, e.g. `Complete "Call mom"`. */
    summary: string;
}

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
