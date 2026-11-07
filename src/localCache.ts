import type { CalendarItem } from "../shared/types.ts";

const KEY = "dash:cache";

interface Saved<S> {
    userId: string;
    state: S;
    calendar?: { key: string; items: CalendarItem[] };
}

interface Store {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

// Looked up inside each try: where storage is blocked, merely reading localStorage throws.
const storage = () => (globalThis as { localStorage?: Store }).localStorage!;

let userId: string | null = null;
let saved: Saved<unknown> | null = null;

function write(value: Saved<unknown> | null) {
    try {
        if (value) storage().setItem(KEY, JSON.stringify(value));
        else storage().removeItem(KEY);
    } catch {
    }
}

export function openCache<S>(user: string | undefined): Saved<S> | null {
    userId = user ?? null;
    saved = null;
    let found: Saved<S> | null;
    try {
        found = JSON.parse(storage().getItem(KEY) ?? "null");
    } catch {
        return null;
    }
    if (!found || !userId) return null;
    if (found.userId !== userId) {
        write(null);
        return null;
    }
    saved = found;
    return found;
}

export function saveState(state: { user: { id: string } }) {
    if (!userId || state.user.id !== userId) return;
    saved = { ...saved, userId, state };
    write(saved);
}

export function saveCalendar(key: string, items: CalendarItem[]) {
    if (!saved) return;
    saved = { ...saved, calendar: { key, items } };
    write(saved);
}

// Also stops saving, so nothing lands back in storage while sign-out navigates away.
export function clearCache() {
    userId = null;
    saved = null;
    write(null);
}
