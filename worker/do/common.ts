/** The project untagged tasks fall back to. */
export const INBOX_ID = "inbox";

/** The next free sort position in a table that orders by sort_order. */
export function nextOrder(sql: SqlStorage, table: "tasks" | "projects" | "habits" | "goals"): number {
    return sql
        .exec<{ next: number }>(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ${table}`)
        .one().next;
}
