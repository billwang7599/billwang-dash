import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (name: string) => env.USER_DO.getByName(name);

describe("UserDO storage", () => {
  it("starts every user with an Inbox", async () => {
    const projects = await stub("u1").listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: "inbox", name: "Inbox", isInbox: true });
  });

  it("files a task without a project into the Inbox", async () => {
    const task = await stub("u2").createTask({ content: "Buy milk" });
    expect(task.projectId).toBe("inbox");
    expect(task.priority).toBe(4);
  });

  it("creates a referenced project on the fly", async () => {
    const s = stub("u3");
    const task = await s.createTask({ content: "Ship it", projectName: "Work" });

    const projects = await s.listProjects();
    expect(projects.map((p) => p.name)).toContain("Work");
    expect(task.projectId).not.toBe("inbox");
  });

  it("reuses an existing project rather than duplicating it", async () => {
    const s = stub("u4");
    await s.createTask({ content: "A", projectName: "Work" });
    await s.createTask({ content: "B", projectName: "work" });
    expect((await s.listProjects()).filter((p) => !p.isInbox)).toHaveLength(1);
  });

  it("round-trips labels and due dates", async () => {
    const s = stub("u5");
    const created = await s.createTask({
      content: "Review",
      labels: ["urgent", "work"],
      priority: 1,
      due: { date: "2026-08-04", time: "17:00", recurrence: null, timeZone: "America/Chicago" },
      durationMinutes: 90,
    });

    const [task] = await s.listTasks();
    expect(task.id).toBe(created.id);
    expect(task.labels).toEqual(["urgent", "work"]);
    expect(task.due).toEqual({
      date: "2026-08-04", time: "17:00", recurrence: null, timeZone: "America/Chicago",
    });
    expect(task.durationMinutes).toBe(90);
  });

  it("isolates users from each other", async () => {
    await stub("alice").createTask({ content: "Alice task" });
    expect(await stub("bob").listTasks()).toHaveLength(0);
  });
});

describe("completing tasks", () => {
  const recurrence = (over: Record<string, unknown> = {}) => ({
    freq: "daily" as const, interval: 1, weekdays: [], month: null,
    monthDay: null, fromCompletion: false, ...over,
  });

  it("closes a one-off task", async () => {
    const s = stub("c1");
    const task = await s.createTask({ content: "One off" });
    const done = await s.completeTask(task.id, "2026-08-03");

    expect(done?.completed).toBe(true);
    expect(done?.completedAt).not.toBeNull();
    expect(await s.listTasks()).toHaveLength(0);
  });

  it("rolls a recurring task forward instead of closing it", async () => {
    const s = stub("c2");
    const task = await s.createTask({
      content: "Vitamins",
      due: { date: "2026-08-03", time: null, recurrence: recurrence(), timeZone: "UTC" },
    });

    const rolled = await s.completeTask(task.id, "2026-08-03");
    expect(rolled?.completed).toBe(false);
    expect(rolled?.due?.date).toBe("2026-08-04");
    expect(await s.listTasks()).toHaveLength(1);
  });

  it("counts a normal rule from the scheduled date, not today", async () => {
    const s = stub("c3");
    const task = await s.createTask({
      content: "Water plants",
      due: { date: "2026-08-01", time: null, recurrence: recurrence({ interval: 3 }), timeZone: "UTC" },
    });

    // Completed three days late; the next occurrence still follows the
    // original schedule rather than jumping from today.
    const rolled = await s.completeTask(task.id, "2026-08-04");
    expect(rolled?.due?.date).toBe("2026-08-04");
  });

  it("counts an `every!` rule from the completion date", async () => {
    const s = stub("c4");
    const task = await s.createTask({
      content: "Change filter",
      due: {
        date: "2026-08-01", time: null,
        recurrence: recurrence({ interval: 3, fromCompletion: true }),
        timeZone: "UTC",
      },
    });

    const rolled = await s.completeTask(task.id, "2026-08-04");
    expect(rolled?.due?.date).toBe("2026-08-07");
  });

  it("reopens a completed task", async () => {
    const s = stub("c5");
    const task = await s.createTask({ content: "Oops" });
    await s.completeTask(task.id, "2026-08-03");
    const reopened = await s.uncompleteTask(task.id);

    expect(reopened?.completed).toBe(false);
    expect(reopened?.completedAt).toBeNull();
  });
});

describe("quick add over HTTP", () => {
  it("parses the raw text server-side and stores the result", async () => {
    const res = await SELF.fetch("https://example.com/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Review specs #Work @urgent p1 tomorrow at 5pm",
        timeZone: "America/Chicago",
      }),
    });
    expect(res.status).toBe(201);

    const { task } = await res.json<{ task: { content: string; priority: number; labels: string[]; due: { time: string } | null } }>();
    expect(task.content).toBe("Review specs");
    expect(task.priority).toBe(1);
    expect(task.labels).toEqual(["urgent"]);
    expect(task.due?.time).toBe("17:00");
  });

  it("rejects text that parses to no content", async () => {
    const res = await SELF.fetch("https://example.com/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "p1 tomorrow" }),
    });
    expect(res.status).toBe(400);
  });
});
