import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarItem } from "../shared/types.ts";
import { clearCache, openCache, saveCalendar, saveState } from "../src/localCache.ts";

class MemoryStorage {
    items = new Map<string, string>();
    getItem(key: string) {
        return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        this.items.set(key, value);
    }
    removeItem(key: string) {
        this.items.delete(key);
    }
}

const stateFor = (userId: string, content = "Buy milk") => ({
    user: { id: userId, email: `${userId}@example.com`, name: null, isAdmin: false },
    tasks: [{ id: "t1", content }],
});

const item: CalendarItem = {
    id: "gcal:1",
    kind: "gcal",
    title: "Standup",
    start: "2026-08-04T10:00:00.000Z",
    end: "2026-08-04T10:15:00.000Z",
    allDay: false,
};

describe("local cache", () => {
    let storage: MemoryStorage;

    beforeEach(() => {
        storage = new MemoryStorage();
        vi.stubGlobal("localStorage", storage);
    });

    afterEach(() => vi.unstubAllGlobals());

    it("has nothing on a first visit", () => {
        expect(openCache("u1")).toBeNull();
    });

    it("gives back what the same user had on screen last visit", () => {
        openCache("u1");
        saveState(stateFor("u1"));
        expect(openCache("u1")?.state).toEqual(stateFor("u1"));
    });

    it("never shows one user's data to another, and wipes it", () => {
        openCache("u1");
        saveState(stateFor("u1"));
        expect(openCache("u2")).toBeNull();
        expect(storage.items.size).toBe(0);
        expect(openCache("u1")).toBeNull();
    });

    it("saves nothing while the page doesn't know who is signed in", () => {
        openCache(undefined);
        saveState(stateFor("u1"));
        expect(storage.items.size).toBe(0);
    });

    it("only saves state that belongs to the page's user", () => {
        openCache("u1");
        saveState(stateFor("u2"));
        expect(openCache("u1")).toBeNull();
    });

    it("keeps the calendar range on screen alongside the state", () => {
        openCache("u1");
        saveState(stateFor("u1"));
        saveCalendar("range", [item]);
        saveState(stateFor("u1", "Call mum"));
        expect(openCache("u1")).toMatchObject({
            state: { tasks: [{ content: "Call mum" }] },
            calendar: { key: "range", items: [item] },
        });
    });

    it("forgets everything on sign-out", () => {
        openCache("u1");
        saveState(stateFor("u1"));
        clearCache();
        expect(storage.items.size).toBe(0);
        saveState(stateFor("u1", "Landed while signing out"));
        expect(openCache("u1")).toBeNull();
    });

    it("still saves for the new user after wiping the last one's data", () => {
        openCache("u1");
        saveState(stateFor("u1"));
        openCache("u2");
        saveState(stateFor("u2"));
        expect(openCache("u2")?.state).toEqual(stateFor("u2"));
    });

    it("treats a corrupt entry as empty", () => {
        openCache("u1");
        saveState(stateFor("u1"));
        const [key] = storage.items.keys();
        storage.setItem(key, "{not json");
        expect(openCache("u1")).toBeNull();
    });

    it("keeps working when storage is full or blocked", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: () => {
                throw new Error("QuotaExceededError");
            },
            removeItem: () => {},
        });
        openCache("u1");
        expect(() => saveState(stateFor("u1"))).not.toThrow();
        vi.stubGlobal("localStorage", undefined);
        expect(openCache("u1")).toBeNull();
        expect(() => clearCache()).not.toThrow();
    });
});
