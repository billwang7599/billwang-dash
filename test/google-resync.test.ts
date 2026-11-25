import { describe, expect, it } from "vitest";
import type { GoogleAccountStatus } from "../shared/types.ts";
import { GoogleApiError } from "../worker/google.ts";
import { refreshFailureKind } from "../worker/google-sync.ts";
import { RECONNECT_URL, resyncOutcome, returnMessage, syncedLabel } from "../src/googleResync.ts";

const status = (over: Partial<GoogleAccountStatus>): GoogleAccountStatus => ({
    connected: true,
    canWrite: true,
    push: { enabled: false, pending: 0, error: null },
    email: "me@example.com",
    connectedAt: null,
    lastSyncedAt: null,
    syncError: null,
    needsReconnect: false,
    calendars: [],
    ...over,
});

describe("what a Resync press leads to", () => {
    it("reconnects only when Google refused the sign-in", () => {
        expect(resyncOutcome(status({}))).toBe("synced");
        expect(resyncOutcome(status({ syncError: "Couldn't reach Google Calendar." }))).toBe("stalled");
        expect(resyncOutcome(status({ syncError: "x", needsReconnect: true }))).toBe("reconnect");
        expect(resyncOutcome(status({ connected: false }))).toBe("not-connected");
    });

    it("comes back to the calendar after signing in", () => {
        expect(RECONNECT_URL).toBe("/api/google/connect?return=calendar");
    });

    it("explains how the sign-in went", () => {
        expect(returnMessage("connected")).toEqual({ notice: "Google Calendar reconnected." });
        expect(returnMessage("access_denied")).toMatchObject({ error: expect.stringMatching(/cancelled/) });
        expect(returnMessage("bad_state")).toMatchObject({ error: expect.stringMatching(/Reconnect/) });
    });
});

describe("last synced label", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    it("reads in minutes, then hours, then a date", () => {
        expect(syncedLabel(null, now)).toBe("Not synced yet");
        expect(syncedLabel("2026-11-25T11:59:30Z", now)).toBe("Synced just now");
        expect(syncedLabel("2026-11-25T11:55:00Z", now)).toBe("Synced 5 min ago");
        expect(syncedLabel("2026-11-25T09:00:00Z", now)).toBe("Synced 3 h ago");
        expect(syncedLabel("2026-11-20T09:00:00Z", now)).toMatch(/^Synced \w+ \d+$/);
    });
});

describe("token refresh failures", () => {
    it("treat a dead grant as needing a sign-in, and anything else as a blip", () => {
        expect(refreshFailureKind(new GoogleApiError(400, "invalid_grant", "x"))).toBe("reauth");
        expect(refreshFailureKind(new GoogleApiError(401, "unauthorized_client", "x"))).toBe("reauth");
        expect(refreshFailureKind(new GoogleApiError(503, null, "x"))).toBe("retry");
        expect(refreshFailureKind(new TypeError("fetch failed"))).toBe("retry");
    });
});
