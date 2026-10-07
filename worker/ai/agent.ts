import { z } from "zod";
import type { Approval, ChatMessage, ChatReply, PendingAction, ToolCall } from "../../shared/chat.ts";
import { civilFromDate, civilKey, minutesOfDay, minutesToTime, weekday } from "../../shared/civil.ts";
import { ServiceError } from "../service.ts";
import { type Stub, type Tool, type ToolContext, tools, toolsByName } from "./tools.ts";

/**
 * The assistant's tool loop. Reads run as the model asks for them. The first
 * write ends the request with `pending`, and the client sends the user's
 * approvals back to resume. History lives in the browser, so the server keeps
 * no chat state of its own.
 *
 * The client can send any history it likes, including tool calls the model
 * never made. That's fine: it is the user's own data, every write goes through
 * the same service layer as the REST API, and arguments are checked again here.
 */

/**
 * gpt-oss-120b made correct tool calls in a probe (looked up ids first, wrote
 * '#Home' in quick-add syntax). Kimi K2.6 needs a paid Workers plan, and
 * GLM-4.7-flash dropped details and claimed writes it hadn't made.
 */
export const MODEL = "@cf/openai/gpt-oss-120b";
const MAX_STEPS = 8;
/** Keeps one big read (a long calendar range, say) from filling the context. */
const MAX_RESULT_CHARS = 20_000;
/** gpt-oss spends output tokens on reasoning first; the default cut replies off mid-sentence. */
const MAX_TOKENS = 4096;

/** The slice of the Workers AI binding the loop uses; tests pass a fake. */
export interface Model {
    run(model: string, input: { messages: unknown[]; tools: unknown[]; max_tokens: number }): Promise<unknown>;
}

const toolDefs = tools.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.args, { io: "input", unrepresentable: "any" });
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
});

export async function runAgent(opts: {
    model: Model;
    stub: Stub;
    timeZone?: string;
    messages: ChatMessage[];
    approvals?: Approval[];
}): Promise<ChatReply> {
    const ctx: ToolContext = {
        stub: opts.stub,
        timeZone: opts.timeZone ?? (await opts.stub.getPreferences()).timeZone,
    };
    const history = [...opts.messages];
    const changed = await settleOpenCalls(ctx, history, opts.approvals ?? []);

    for (let step = 0; step < MAX_STEPS; step++) {
        let raw: unknown;
        try {
            raw = await opts.model.run(MODEL, {
                messages: [{ role: "system", content: systemPrompt(ctx.timeZone) }, ...history],
                tools: toolDefs,
                max_tokens: MAX_TOKENS,
            });
        } catch (err) {
            console.error("ai: model call failed", err);
            throw new ServiceError(503, "The assistant couldn't answer just now. Try again in a moment.");
        }
        const reply = parseReply(raw);
        history.push(reply);
        if (!reply.tool_calls?.length) return { messages: history, pending: [], changed };

        const pending: PendingAction[] = [];
        for (const call of reply.tool_calls) {
            const tool = toolsByName.get(call.function.name);
            const args = tool && parseArgs(tool, call);
            if (!tool) {
                history.push(toolResult(call, { error: `no tool named ${call.function.name}` }));
            } else if (!args!.success) {
                history.push(toolResult(call, { error: args!.error }));
            } else if (tool.kind === "read") {
                history.push(toolResult(call, await runTool(ctx, tool, args!.data)));
            } else {
                pending.push({
                    toolCallId: call.id,
                    name: tool.name,
                    summary: await tool.summarize!(ctx, args!.data),
                });
            }
        }
        if (pending.length) return { messages: history, pending, changed };
    }

    history.push({
        role: "assistant",
        content: "I stopped after too many steps without finishing. Try asking for something narrower.",
    });
    return { messages: history, pending: [], changed };
}

/**
 * Answers every tool call in the last assistant message that has no result yet:
 * approved writes run, and anything else counts as declined. A call left
 * unanswered would make the next model request invalid, so this also covers a
 * user who types a new message instead of clicking Approve or Decline.
 */
async function settleOpenCalls(ctx: ToolContext, history: ChatMessage[], approvals: Approval[]): Promise<boolean> {
    const last = [...history].reverse().find((m) => m.role === "assistant");
    if (last?.role !== "assistant" || !last.tool_calls) return false;

    const answered = new Set(history.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
    let changed = false;
    for (const call of last.tool_calls) {
        if (answered.has(call.id)) continue;
        const tool = toolsByName.get(call.function.name);
        const approved = approvals.some((a) => a.toolCallId === call.id && a.approved);
        if (!tool || tool.kind !== "write" || !approved) {
            history.push(toolResult(call, { error: "The user declined this. Don't retry unless they ask." }));
            continue;
        }
        const args = parseArgs(tool, call);
        if (!args.success) {
            history.push(toolResult(call, { error: args.error }));
            continue;
        }
        // An approval can arrive twice for the same call (see do/ai-runs.ts): replay, don't rerun.
        const claim = await ctx.stub.claimToolRun(call.id);
        if (!claim.claimed) {
            history.push(
                claim.result === null
                    ? toolResult(call, { error: "An earlier request is still making this change." })
                    : { role: "tool", tool_call_id: call.id, content: claim.result },
            );
            // The client sending a stale approval missed that earlier reply, so its view is out of date.
            changed = true;
            continue;
        }
        const result = await runTool(ctx, tool, args.data);
        const message = toolResult(call, result);
        await ctx.stub.finishToolRun(call.id, message.content);
        changed ||= !("error" in result);
        history.push(message);
    }
    return changed;
}

function parseArgs(tool: Tool, call: ToolCall): { success: true; data: unknown } | { success: false; error: string } {
    let raw: unknown;
    try {
        raw = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : call.function.arguments;
    } catch {
        return { success: false, error: "arguments were not valid JSON" };
    }
    const parsed = tool.args.safeParse(raw);
    return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, error: z.prettifyError(parsed.error) };
}

/** Errors go back to the model as results so it can correct itself, not up as a 500. */
async function runTool(ctx: ToolContext, tool: Tool, args: unknown): Promise<{ result: unknown } | { error: string }> {
    try {
        return { result: (await tool.run(ctx, args)) ?? "done" };
    } catch (err) {
        if (err instanceof ServiceError) return { error: err.message };
        console.error("ai: tool failed", tool.name, err);
        return { error: "internal error" };
    }
}

function toolResult(call: ToolCall, body: unknown): Extract<ChatMessage, { role: "tool" }> {
    return { role: "tool", tool_call_id: call.id, content: JSON.stringify(body).slice(0, MAX_RESULT_CHARS) };
}

/** Workers AI returns OpenAI's `choices` shape for chat models, and `response` for some older ones. */
function parseReply(raw: unknown): Extract<ChatMessage, { role: "assistant" }> {
    const r = raw as {
        choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
        response?: string;
        tool_calls?: ToolCall[];
    };
    const msg = r.choices?.[0]?.message ?? { content: r.response, tool_calls: r.tool_calls };
    const toolCalls = msg.tool_calls?.length ? msg.tool_calls : undefined;
    // "" rather than null: gpt-oss rejects a null content when the turn is sent back to it.
    return { role: "assistant", content: msg.content ?? "", ...(toolCalls && { tool_calls: toolCalls }) };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function systemPrompt(timeZone: string): string {
    const now = new Date();
    const today = civilFromDate(now, timeZone);
    return `You are the assistant inside the user's personal dashboard. You help them see and change their tasks, projects, calendar events, habits and goals.

Now: ${WEEKDAYS[weekday(today)]} ${civilKey(today)}, ${minutesToTime(minutesOfDay(now, timeZone))} in ${timeZone}. Give dates and times in this zone.

The data:
- Projects hold tasks. The Inbox project is where tasks without a project go, and it can't be deleted.
- Tasks have a priority (1 is highest, 4 is none), an optional due date and time (which may repeat), an optional hard deadline, and may be a step toward a goal.
- Events are the user's own calendar entries. Google Calendar events show up in get_calendar but are read-only here.
- Habits are daily, a number of times per week, or on set weekdays, and get checked off per day.
- Goals have a deadline and either a numeric target (current out of target, in a unit) or a yes/no target (target null).

How to work:
- Use the tools for every fact. Never invent ids or data. Call get_overview before acting on something the user names.
- To add a task, prefer quick_add_task and put the date, #Project and priority in the text the way the user would type it.
- Changes need the user's approval in the app, so make the change rather than asking first in words. Once a change is done or declined, say so in one short sentence.
- Keep answers short. Write plain text, not Markdown: no **bold**, headings or tables. For more than three items, put each on its own line starting with "- ".`;
}
