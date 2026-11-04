export const LIVE_REFRESH_MS = 30_000;
export const DAY_CHECK_MS = 60_000;

let writesInFlight = 0;
let writesStarted = 0;
let reading: Promise<unknown> | null = null;

export function startWrite(): () => void {
    writesInFlight++;
    writesStarted++;
    return () => {
        writesInFlight--;
    };
}

// Null when a write overlapped the read: its answer may predate the write and undo an edit on screen.
export function quietRead<T>(read: () => Promise<T>): Promise<T | null> {
    if (writesInFlight > 0) return Promise.resolve(null);
    if (reading) return reading as Promise<T | null>;
    const before = writesStarted;
    const current = read()
        .then((value) => (writesStarted === before ? value : null))
        .finally(() => {
            reading = null;
        });
    reading = current;
    return current;
}

export function watchForChanges({
    doc,
    win,
    refresh,
    today,
    onNewDay,
}: {
    doc: EventTarget & { hidden: boolean };
    win: EventTarget;
    refresh: () => void;
    today: () => string;
    onNewDay: (day: string) => void;
}): () => void {
    let day = today();
    const newDay = () => {
        const now = today();
        if (now === day) return false;
        day = now;
        onNewDay(now);
        return true;
    };
    const wake = () => {
        if (doc.hidden) return;
        newDay();
        refresh();
    };
    const checkDay = () => {
        if (!doc.hidden && newDay()) refresh();
    };
    const poll = () => {
        if (!doc.hidden) refresh();
    };
    const pollTimer = setInterval(poll, LIVE_REFRESH_MS);
    const dayTimer = setInterval(checkDay, DAY_CHECK_MS);
    doc.addEventListener("visibilitychange", wake);
    win.addEventListener("focus", wake);
    return () => {
        clearInterval(pollTimer);
        clearInterval(dayTimer);
        doc.removeEventListener("visibilitychange", wake);
        win.removeEventListener("focus", wake);
    };
}
