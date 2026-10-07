/**
 * Makes approved assistant writes idempotent. The client holds the chat, so it
 * can send the same approval twice: a double click, a second tab, or a reply
 * that landed after the user left the page and so never replaced the cards.
 * Each tool call id may run once; later approvals get the first run's result.
 *
 * The claim is one synchronous statement inside the DO, so two requests racing
 * on the same id can't both win.
 */

/** Long enough that no chat still holds the call; short enough the table stays small. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export type ToolRunClaim =
    | { claimed: true }
    /** `result` is null while the first run is still going. */
    | { claimed: false; result: string | null };

export function claimToolRun(sql: SqlStorage, toolCallId: string, now: number): ToolRunClaim {
    sql.exec("DELETE FROM ai_tool_runs WHERE created_at < ?", now - KEEP_MS);
    const inserted = sql.exec(
        "INSERT OR IGNORE INTO ai_tool_runs (tool_call_id, result, created_at) VALUES (?, NULL, ?)",
        toolCallId,
        now,
    ).rowsWritten;
    if (inserted > 0) return { claimed: true };
    const row = sql
        .exec<{ result: string | null }>("SELECT result FROM ai_tool_runs WHERE tool_call_id = ?", toolCallId)
        .one();
    return { claimed: false, result: row.result };
}

export function finishToolRun(sql: SqlStorage, toolCallId: string, result: string): void {
    sql.exec("UPDATE ai_tool_runs SET result = ? WHERE tool_call_id = ?", result, toolCallId);
}
