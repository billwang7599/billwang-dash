import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrations } from "../worker/do/migrations.ts";

const stub = (name: string) => env.USER_DO.getByName(name);
const sql = (s: ReturnType<typeof stub>, fn: (sql: SqlStorage) => void) =>
    runInDurableObject(s, (_i, state) => fn(state.storage.sql));

const weekly = {
    freq: "weekly" as const,
    interval: 1,
    weekdays: [],
    month: null,
    monthDay: null,
    fromCompletion: false,
};

describe("due dates are instants", () => {
    it("moves a timed task's clock time when the zone changes, without moving the moment", async () => {
        const s = stub("due-zone");
        await s.setPreferences({ timeZone: "America/Los_Angeles" });
        const t = await s.createTask({ content: "Report", due: { date: "2026-08-04", time: "20:00", recurrence: null } });
        expect(t.due).toMatchObject({ date: "2026-08-04", time: "20:00" });

        await s.setPreferences({ timeZone: "America/Toronto" });
        expect((await s.getTask(t.id))!.due).toMatchObject({ date: "2026-08-04", time: "23:00" });
    });

    it("keeps a date-only task all-day, on the end of its day", async () => {
        const s = stub("due-dateonly");
        const t = await s.createTask({ content: "Renew", due: { date: "2026-08-06", time: null, recurrence: null } });
        expect(t.due).toMatchObject({ date: "2026-08-06", time: null });
        const [row] = await runInDurableObject(s, (_i, state) =>
            state.storage.sql.exec<{ due_at: number }>("SELECT due_at FROM tasks WHERE id = ?", t.id).toArray(),
        );
        expect(new Date(row.due_at).toISOString()).toBe("2026-08-06T23:59:00.000Z");
    });

    it("keeps the original zone when a save leaves the due moment alone", async () => {
        const s = stub("due-resave");
        await s.setPreferences({ timeZone: "America/Los_Angeles" });
        const t = await s.createTask({ content: "Report", due: { date: "2026-08-04", time: "20:00", recurrence: null } });

        await s.setPreferences({ timeZone: "America/Toronto" });
        // What the form sends back: the same moment, as Toronto sees it.
        await s.updateTask(t.id, { content: "Report v2", due: { date: "2026-08-04", time: "23:00", recurrence: null } });

        const [row] = await runInDurableObject(s, (_i, state) =>
            state.storage.sql.exec<{ due_tz: string }>("SELECT due_tz FROM tasks WHERE id = ?", t.id).toArray(),
        );
        expect(row.due_tz).toBe("America/Los_Angeles");
    });

    it("repeats at the same local time in the zone it was set in, across a DST change", async () => {
        const s = stub("due-repeat");
        await s.setPreferences({ timeZone: "America/New_York" });
        const t = await s.createTask({
            content: "Standup",
            due: { date: "2026-03-02", time: "09:00", recurrence: weekly },
        });

        // Read from Tokyo: the next one is 09:00 New York time, which is now EDT.
        await s.setPreferences({ timeZone: "Asia/Tokyo" });
        const next = await s.completeTask(t.id, "2026-03-02");
        expect(next!.due).toMatchObject({ date: "2026-03-09", time: "22:00" });
    });

    it("upgrades a database from before instants, reading its old dates in the profile zone", async () => {
        const s = stub("due-upgrade");
        await s.setPreferences({ timeZone: "Asia/Tokyo" });
        await sql(s, (db) => {
            // Back to the schema as it was at version 21 (the last with text dates), then forward through the real migrations.
            const tables = db
                .exec<{ name: string }>(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'",
                )
                .toArray()
                .map((r) => r.name);
            for (let pass = 0; pass < tables.length; pass++) {
                for (const t of tables) {
                    try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch { /* referenced by another; next pass */ }
                }
            }
            for (const m of migrations.filter((m) => m.version <= 21)) {
                db.exec(m.sql);
                m.after?.(db);
            }
            db.exec("UPDATE profile SET time_zone = 'Asia/Tokyo'");
            const task = (id: string, date: string | null, time: string | null, deadline: string | null) =>
                db.exec(
                    `INSERT INTO tasks (id, content, project_id, due_date, due_time, deadline, created_at, updated_at, completed_at)
                     VALUES (?, ?, 'inbox', ?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL)`,
                    id, id, date, time, deadline,
                );
            task("timed", "2026-08-04", "17:00", "2026-08-10");
            task("dateonly", "2026-08-05", null, null);
            task("none", null, null, null);
            db.exec(
                `INSERT INTO goals (id, title, horizon, target, deadline, created_at, updated_at)
                 VALUES ('g', 'Read', 'short', NULL, '2026-12-31', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
            );
            db.exec(
                `INSERT INTO events (id, title, start_date, start_time, end_date, end_time, created_at, updated_at)
                 VALUES ('timed-ev', 'Call', '2026-08-04', '15:00', '2026-08-04', '16:00', '', ''),
                        ('allday-ev', 'Holiday', '2026-08-06', NULL, '2026-08-07', NULL, '', '')`,
            );
            for (const m of migrations.filter((m) => m.version > 21)) {
                db.exec(m.sql);
                m.after?.(db);
            }
        });

        const tasks = await s.listTasks();
        const by = (id: string) => tasks.find((t) => t.id === id)!;
        expect(by("timed").due).toMatchObject({ date: "2026-08-04", time: "17:00" });
        expect(by("timed").deadline).toBe("2026-08-10");
        expect(by("timed").createdAt).toBe("2026-08-01T00:00:00.000Z");
        expect(by("dateonly").due).toMatchObject({ date: "2026-08-05", time: null });
        expect(by("none").due).toBeNull();

        expect((await s.listGoals())[0]).toMatchObject({ deadline: "2026-12-31", createdAt: "2026-08-01T00:00:00.000Z" });

        const events = (await s.getCalendarItems("2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z")).filter((i) => i.kind === "event");
        const ev = (id: string) => events.find((i) => i.id === `event:${id}`)!;
        expect(ev("timed-ev").event).toMatchObject({ startDate: "2026-08-04", startTime: "15:00", endTime: "16:00" });
        expect(ev("timed-ev").start).toBe("2026-08-04T06:00:00.000Z"); // 15:00 in Tokyo
        expect(ev("allday-ev")).toMatchObject({ allDay: true });
        expect(ev("allday-ev").event).toMatchObject({ startDate: "2026-08-06", endDate: "2026-08-07", startTime: null });
    });
});
