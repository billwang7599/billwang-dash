import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, civilFromDate, civilKey } from "../shared/civil.ts";
import { isFresh, runs, TODAY_TTL_MS, futureTtlMs } from "../worker/do/gcal-cache.ts";
import { WRITE_SCOPE } from "../worker/google.ts";

/** A Google that only lists events, recording each list request's window. */
function fakeGoogle() {
    const lists: { timeMin: string; timeMax: string }[] = [];
    let events: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const path = decodeURIComponent(url.pathname.replace("/calendar/v3", ""));
        const reply = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });
        if ((init?.method ?? "GET") !== "GET") return new Response(null, { status: 204 });
        if (path === "/users/me/calendarList") {
            return reply({ items: [{ id: "me@example.com", summary: "Me", primary: true }] });
        }
        if (/^\/calendars\/[^/]+\/events$/.test(path)) {
            lists.push({ timeMin: url.searchParams.get("timeMin")!, timeMax: url.searchParams.get("timeMax")! });
            return reply({ items: events });
        }
        return new Response(null, { status: 404 });
    });
    return { lists, setEvents: (e: unknown[]) => (events = e) };
}

/** Days relative to today in UTC (the tests set the user's zone to UTC). */
const today = civilFromDate(new Date(), "UTC");
const day = (offset: number) => civilKey(addDays(today, offset));
const at = (offset: number, time = "00:00") => `${day(offset)}T${time}:00.000Z`;
const timedEvent = (id: string, offset: number) => ({
    id,
    summary: id,
    start: { dateTime: at(offset, "15:00") },
    end: { dateTime: at(offset, "16:00") },
});
const titles = (items: { kind: string; title: string }[]) =>
    items.filter((i) => i.kind === "gcal").map((i) => i.title);

async function connected(name: string) {
    const stub = env.USER_DO.getByName(name);
    await stub.setPreferences({ timeZone: "UTC" });
    await stub.connectGoogle({
        accessToken: "tok",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        email: "me@example.com",
        scope: `https://www.googleapis.com/auth/calendar.readonly ${WRITE_SCOPE} openid email`,
    });
    return stub;
}

/** Pretends every cached day was fetched `ms` earlier than it was. */
const age = (stub: ReturnType<typeof env.USER_DO.getByName>, ms: number) =>
    runInDurableObject(stub, (_i, state) => {
        state.storage.sql.exec("UPDATE gcal_cache_days SET synced_at = synced_at - ?", ms);
    });

afterEach(() => vi.restoreAllMocks());

describe("google event cache: freshness rules", () => {
    const now = Date.now();
    it("keeps past days until a manual sync, today for six hours, later days for longer the further out", () => {
        expect(isFresh(day(-3), day(0), now - 90 * 86_400_000, now)).toBe(true);
        expect(isFresh(day(0), day(0), now - TODAY_TTL_MS + 1000, now)).toBe(true);
        expect(isFresh(day(0), day(0), now - TODAY_TTL_MS - 1000, now)).toBe(false);
        expect(futureTtlMs(1)).toBe(12 * 3_600_000);
        expect(futureTtlMs(2)).toBe(24 * 3_600_000);
        expect(futureTtlMs(30)).toBe(7 * 86_400_000);
        expect(isFresh(day(2), day(0), now - futureTtlMs(2) + 1000, now)).toBe(true);
        expect(isFresh(day(2), day(0), now - futureTtlMs(2) - 1000, now)).toBe(false);
    });

    it("groups consecutive days into one request each", () => {
        expect(runs([day(0), day(1), day(2), day(5), day(6)])).toEqual([
            [day(0), day(2)],
            [day(5), day(6)],
        ]);
    });
});

describe("google event cache", () => {
    it("serves a second look from the cache", async () => {
        const g = fakeGoogle();
        g.setEvents([timedEvent("Dentist", 1)]);
        const stub = await connected("gc-hit");

        expect(titles(await stub.getCalendarItems(at(0), at(7)))).toEqual(["Dentist"]);
        expect(g.lists).toHaveLength(1);
        expect(titles(await stub.getCalendarItems(at(0), at(7)))).toEqual(["Dentist"]);
        expect(g.lists).toHaveLength(1);
    });

    it("fetches only the days it hasn't got", async () => {
        const g = fakeGoogle();
        const stub = await connected("gc-partial");

        await stub.getCalendarItems(at(0), at(1)); // today
        await stub.getCalendarItems(at(0), at(3)); // today and the next two days
        expect(g.lists).toHaveLength(2);
        expect(g.lists[1]).toEqual({ timeMin: at(1), timeMax: at(3) });
    });

    it("refetches today after six hours and later days after longer", async () => {
        const g = fakeGoogle();
        const stub = await connected("gc-stale");
        await stub.getCalendarItems(at(0), at(3));
        expect(g.lists).toHaveLength(1);

        await age(stub, TODAY_TTL_MS + 60_000);
        await stub.getCalendarItems(at(0), at(3));
        expect(g.lists[1]).toEqual({ timeMin: at(0), timeMax: at(1) }); // just today

        await age(stub, futureTtlMs(1)); // tomorrow is now stale too; the days after it are not
        await stub.getCalendarItems(at(0), at(3));
        expect(g.lists[2]).toEqual({ timeMin: at(0), timeMax: at(2) });

        await age(stub, futureTtlMs(3));
        await stub.getCalendarItems(at(0), at(3));
        expect(g.lists[3]).toEqual({ timeMin: at(0), timeMax: at(3) });
    });

    it("never refetches a past day on its own, but does after a manual sync", async () => {
        const g = fakeGoogle();
        const stub = await connected("gc-past");
        // Ten days back is never in the current week, which a manual sync fetches itself.
        await stub.getCalendarItems(at(-10), at(-9));
        await age(stub, 30 * 86_400_000);
        await stub.getCalendarItems(at(-10), at(-9));
        expect(g.lists).toHaveLength(1);

        await stub.syncGoogleNow();
        const afterSync = g.lists.length;
        await stub.getCalendarItems(at(-10), at(-9));
        expect(g.lists).toHaveLength(afterSync + 1);
        expect(g.lists.at(-1)).toEqual({ timeMin: at(-10), timeMax: at(-9) });
    });

    it("keeps an old month it was just asked for, instead of pruning it straight away", async () => {
        const g = fakeGoogle();
        g.setEvents([timedEvent("Old", -60)]);
        const stub = await connected("gc-old");
        expect(titles(await stub.getCalendarItems(at(-62), at(-55)))).toEqual(["Old"]);
        expect(titles(await stub.getCalendarItems(at(-62), at(-55)))).toEqual(["Old"]);
        expect(g.lists).toHaveLength(1);
    });

    it("drops an event deleted in Google when its day is refetched", async () => {
        const g = fakeGoogle();
        g.setEvents([timedEvent("Lunch", 1)]);
        const stub = await connected("gc-deleted");
        expect(titles(await stub.getCalendarItems(at(0), at(3)))).toEqual(["Lunch"]);

        g.setEvents([]);
        expect(titles(await stub.getCalendarItems(at(0), at(3)))).toEqual(["Lunch"]); // still cached
        await age(stub, futureTtlMs(1));
        expect(titles(await stub.getCalendarItems(at(0), at(3)))).toEqual([]);
    });

    it("keeps an all-day event on its own date", async () => {
        const g = fakeGoogle();
        g.setEvents([{ id: "Holiday", summary: "Holiday", start: { date: day(2) }, end: { date: day(3) } }]);
        const stub = await connected("gc-allday");
        await stub.getCalendarItems(at(0), at(7));
        expect(titles(await stub.getCalendarItems(at(2), at(3)))).toEqual(["Holiday"]);
        expect(titles(await stub.getCalendarItems(at(3), at(4)))).toEqual([]);
    });

    it("forgets everything on disconnect", async () => {
        const g = fakeGoogle();
        g.setEvents([timedEvent("Dentist", 1)]);
        const stub = await connected("gc-disconnect");
        await stub.getCalendarItems(at(0), at(7));
        await stub.disconnectGoogle();
        const rows = await runInDurableObject(stub, (_i, state) => [
            state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM gcal_cache_days").one().n,
            state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM gcal_cache_events").one().n,
        ]);
        expect(rows).toEqual([0, 0]);
    });
});
