import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as service from "../worker/service.ts";
import { ServiceError } from "../worker/service.ts";

const stub = (name: string) => env.USER_DO.getByName(name);

/**
 * The service layer is callable without an HTTP request, so these exercise it
 * directly. The HTTP tests below then confirm index.ts maps ServiceError onto
 * the right status via app.onError().
 */
describe("service layer", () => {
  it("rejects empty quick-add text", async () => {
    await expect(service.quickAddTask(stub("s1"), "  ", "UTC")).rejects.toThrow(ServiceError);
  });

  it("rejects text that parses to nothing but tokens", async () => {
    await expect(service.quickAddTask(stub("s2"), "p1 tomorrow", "UTC")).rejects.toMatchObject({
      status: 400,
      message: "task has no content",
    });
  });

  it("404s completing a task that does not exist", async () => {
    await expect(service.completeTask(stub("s3"), "no-such-id")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses to delete the Inbox", async () => {
    await expect(service.deleteProject(stub("s4"), "inbox")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a non-ISO calendar window", async () => {
    await expect(service.calendarItems(stub("s5"), "soon", "later")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("creates a task end to end", async () => {
    const { task, parsed } = await service.quickAddTask(
      stub("s6"),
      "Write specs #Work p1 tomorrow at 3pm",
      "America/Chicago",
    );
    expect(task.content).toBe("Write specs");
    expect(task.priority).toBe(1);
    expect(parsed.due?.time).toBe("15:00");
  });
});

describe("ServiceError maps to HTTP status", () => {
  it("400 for an empty quick add", async () => {
    const res = await SELF.fetch("https://example.com/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("text is required");
  });

  it("404 for completing a missing task", async () => {
    const res = await SELF.fetch("https://example.com/api/tasks/nope/complete", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("400 for deleting the Inbox", async () => {
    const res = await SELF.fetch("https://example.com/api/projects/inbox", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});
