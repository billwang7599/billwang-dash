import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_CHECK_MS, LIVE_REFRESH_MS, quietRead, startWrite, watchForChanges } from "../src/liveRefresh.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

describe("quietRead", () => {
    it("returns what it read when nothing was written meanwhile", async () => {
        expect(await quietRead(async () => "fresh")).toBe("fresh");
    });

    it("skips the read while a write is in flight", async () => {
        const done = startWrite();
        const read = vi.fn(async () => "fresh");
        expect(await quietRead(read)).toBeNull();
        expect(read).not.toHaveBeenCalled();
        done();
        expect(await quietRead(read)).toBe("fresh");
    });

    it("drops the answer when a write started while it was reading", async () => {
        const answer = deferred<string>();
        const result = quietRead(() => answer.promise);
        startWrite()();
        answer.resolve("stale");
        expect(await result).toBeNull();
    });

    it("shares one read between callers that overlap", async () => {
        const answer = deferred<string>();
        const read = vi.fn(() => answer.promise);
        const both = Promise.all([quietRead(read), quietRead(read)]);
        answer.resolve("fresh");
        expect(await both).toEqual(["fresh", "fresh"]);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("lets the next read through after one fails", async () => {
        await expect(quietRead(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
        expect(await quietRead(async () => "fresh")).toBe("fresh");
    });
});

describe("watchForChanges", () => {
    let doc: EventTarget & { hidden: boolean };
    let win: EventTarget;
    let day: string;
    let refresh: ReturnType<typeof vi.fn>;
    let onNewDay: ReturnType<typeof vi.fn>;
    let stop: () => void;

    beforeEach(() => {
        vi.useFakeTimers();
        doc = Object.assign(new EventTarget(), { hidden: false });
        win = new EventTarget();
        day = "2026-11-03";
        refresh = vi.fn();
        onNewDay = vi.fn();
        stop = watchForChanges({ doc, win, refresh, today: () => day, onNewDay });
    });

    afterEach(() => {
        stop();
        vi.useRealTimers();
    });

    it("refreshes on its interval while the tab is visible", () => {
        vi.advanceTimersByTime(LIVE_REFRESH_MS - 1);
        expect(refresh).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not poll while the tab is hidden", () => {
        doc.hidden = true;
        vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("refreshes as soon as the tab is shown or the window focused", () => {
        doc.hidden = true;
        doc.dispatchEvent(new Event("visibilitychange"));
        expect(refresh).not.toHaveBeenCalled();
        doc.hidden = false;
        doc.dispatchEvent(new Event("visibilitychange"));
        expect(refresh).toHaveBeenCalledTimes(1);
        win.dispatchEvent(new Event("focus"));
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("moves to the new day within a minute, and refreshes for it", () => {
        vi.advanceTimersByTime(DAY_CHECK_MS);
        expect(onNewDay).not.toHaveBeenCalled();
        day = "2026-11-04";
        vi.advanceTimersByTime(DAY_CHECK_MS);
        expect(onNewDay).toHaveBeenCalledWith("2026-11-04");
        const polls = Math.floor((2 * DAY_CHECK_MS) / LIVE_REFRESH_MS);
        expect(refresh).toHaveBeenCalledTimes(polls + 1);
    });

    it("catches a day that changed while hidden as soon as the tab is shown", () => {
        doc.hidden = true;
        day = "2026-11-04";
        doc.hidden = false;
        doc.dispatchEvent(new Event("visibilitychange"));
        expect(onNewDay).toHaveBeenCalledWith("2026-11-04");
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("stops listening once stopped", () => {
        stop();
        win.dispatchEvent(new Event("focus"));
        vi.advanceTimersByTime(LIVE_REFRESH_MS * 2);
        expect(refresh).not.toHaveBeenCalled();
    });
});
