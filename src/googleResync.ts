import type { GoogleAccountStatus } from "../shared/types.ts";

/** Google's sign-in, coming back to the calendar afterwards rather than to Settings. */
export const RECONNECT_URL = "/api/google/connect?return=calendar";

/** What a press of Resync found, and so what the calendar does next. */
export type ResyncOutcome = "synced" | "reconnect" | "stalled" | "not-connected";

export function resyncOutcome(status: GoogleAccountStatus): ResyncOutcome {
    if (!status.connected) return "not-connected";
    if (status.needsReconnect) return "reconnect";
    return status.syncError ? "stalled" : "synced";
}

/** "Synced just now", "Synced 5 min ago", "Synced 3 h ago", then the date. */
export function syncedLabel(lastSyncedAt: string | null, now = Date.now()): string {
    if (!lastSyncedAt) return "Not synced yet";
    const minutes = Math.floor((now - Date.parse(lastSyncedAt)) / 60_000);
    if (minutes < 1) return "Synced just now";
    if (minutes < 60) return `Synced ${minutes} min ago`;
    if (minutes < 24 * 60) return `Synced ${Math.floor(minutes / 60)} h ago`;
    return `Synced ${new Date(lastSyncedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * What to say after Google's sign-in sends the user back with `?google=<result>`:
 * a notice for success, an error otherwise.
 */
export function returnMessage(result: string): { notice: string } | { error: string } {
    if (result === "connected") return { notice: "Google Calendar reconnected." };
    if (result === "access_denied") return { error: "Google sign-in was cancelled. Events shown were saved earlier." };
    if (result === "bad_state" || result === "missing_code") {
        return { error: "Google sign-in didn't finish. Press Reconnect to try again." };
    }
    return { error: result };
}
