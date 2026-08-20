import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CalendarItem } from "../shared/types.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

const WEEK_START = "2026-08-03T00:00:00.000Z";
const WEEK_END = "2026-08-10T00:00:00.000Z";

describe("calendar feed", () => {
  it("places a timed task at its wall-clock time in its own zone", async () => {
    const s = stub("cal1");
    await s.setPreferences({ timeZone: "America/Chicago" });
    await s.createTask({
      content: "Design review",
      priority: 1,
      durationMinutes: 90,
      due: {
        date: "2026-08-04", time: "15:00",
        recurrence: null, timeZone: "America/Chicago",
      },
    });

    const items = await s.getCalendarItems(WEEK_START, WEEK_END);
    expect(items).toHaveLength(1);

    // 15:00 CDT (UTC-5) is 20:00Z; the 90m duration carries through.
    expect(items[0]).toMatchObject({
      kind: "task",
      title: "Design review",
      start: "2026-08-04T20:00:00.000Z",
      end: "2026-08-04T21:30:00.000Z",
      allDay: false,
      priority: 1,
    });
  });

  it("keeps a task's original zone when the preference changes later", async () => {
    const s = stub("cal2");
    await s.createTask({
      content: "Booked in Tokyo",
      due: { date: "2026-08-05", time: "09:00", recurrence: null, timeZone: "Asia/Tokyo" },
    });
    // Moving the default zone must not shift an already-scheduled task.
    await s.setPreferences({ timeZone: "America/Chicago" });

    const [item] = await s.getCalendarItems(WEEK_START, WEEK_END);
    expect(item.start).toBe("2026-08-05T00:00:00.000Z"); // 09:00 JST = 00:00Z
  });

  it("marks an undated-time task as all day", async () => {
    const s = stub("cal3");
    await s.createTask({
      content: "Renew passport",
      due: { date: "2026-08-06", time: null, recurrence: null, timeZone: "UTC" },
    });

    const [item] = await s.getCalendarItems(WEEK_START, WEEK_END);
    expect(item.allDay).toBe(true);
    expect(item.start).toBe("2026-08-06T00:00:00.000Z");
    expect(item.end).toBe("2026-08-07T00:00:00.000Z");
  });

  it("excludes tasks outside the window and completed ones", async () => {
    const s = stub("cal4");
    await s.createTask({
      content: "Next month",
      due: { date: "2026-09-15", time: "10:00", recurrence: null, timeZone: "UTC" },
    });
    const done = await s.createTask({
      content: "Already done",
      due: { date: "2026-08-05", time: "10:00", recurrence: null, timeZone: "UTC" },
    });
    await s.completeTask(done.id, "2026-08-05");

    expect(await s.getCalendarItems(WEEK_START, WEEK_END)).toHaveLength(0);
  });

  it("returns nothing from Google when no account is connected", async () => {
    const status = await stub("cal5").getGoogleStatus();
    expect(status.connected).toBe(false);
    expect(status.calendars).toEqual([]);
  });
});

describe("calendar endpoint", () => {
  it("requires a start and end", async () => {
    const res = await SELF.fetch("https://example.com/api/calendar");
    expect(res.status).toBe(400);
  });

  it("rejects non-ISO bounds", async () => {
    const res = await SELF.fetch("https://example.com/api/calendar?start=soon&end=later");
    expect(res.status).toBe(400);
  });

  it("returns merged items for a valid window", async () => {
    await SELF.fetch("https://example.com/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Standup tomorrow at 9am", timeZone: "UTC" }),
    });

    const res = await SELF.fetch(
      `https://example.com/api/calendar?start=${WEEK_START}&end=${WEEK_END}`,
    );
    expect(res.status).toBe(200);
    const { items } = await res.json<{ items: CalendarItem[] }>();
    expect(Array.isArray(items)).toBe(true);
  });
});
