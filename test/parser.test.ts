import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../shared/parser.ts";
import { nextOccurrence } from "../shared/parser.ts";
import { civilFromKey, civilKey } from "../shared/civil.ts";

// Monday 2026-08-03, 10:00 America/Chicago.
const NOW = new Date("2026-08-03T15:00:00Z");
const TZ = "America/Chicago";

const parse = (input: string) =>
  parseQuickAdd(input, { now: NOW, timeZone: TZ });

describe("content extraction", () => {
  it("strips every recognised token", () => {
    const r = parse("Review specs #Work @urgent p1 tomorrow at 5pm for 90m");
    expect(r.content).toBe("Review specs");
    expect(r.projectName).toBe("Work");
    expect(r.labels).toEqual(["urgent"]);
    expect(r.priority).toBe(1);
    expect(r.due?.date).toBe("2026-08-04");
    expect(r.due?.time).toBe("17:00");
    expect(r.durationMinutes).toBe(90);
  });

  it("leaves plain text untouched", () => {
    const r = parse("Buy milk");
    expect(r.content).toBe("Buy milk");
    expect(r.due).toBeNull();
    expect(r.priority).toBe(4);
  });

  it("supports quoted multi-word projects and labels", () => {
    const r = parse('Ship it #"Q3 Launch" @"deep work"');
    expect(r.content).toBe("Ship it");
    expect(r.projectName).toBe("Q3 Launch");
    expect(r.labels).toEqual(["deep work"]);
  });

  it("collects multiple labels", () => {
    const r = parse("Email team @work @email @followup");
    expect(r.labels).toEqual(["work", "email", "followup"]);
    expect(r.content).toBe("Email team");
  });

  it("does not treat a sigil inside a word as a token", () => {
    const r = parse("Reply to bill@example.com about C#");
    expect(r.labels).toEqual([]);
    expect(r.content).toBe("Reply to bill@example.com about C#");
  });
});

describe("relative dates", () => {
  it.each([
    ["today", "2026-08-03"],
    ["tod", "2026-08-03"],
    ["tomorrow", "2026-08-04"],
    ["tmrw", "2026-08-04"],
    ["yesterday", "2026-08-02"],
    ["in 3 days", "2026-08-06"],
    ["in a week", "2026-08-10"],
    ["in 2 weeks", "2026-08-17"],
    ["in 1 month", "2026-09-03"],
    ["next week", "2026-08-10"],
    ["next month", "2026-09-03"],
    ["next year", "2027-08-03"],
    ["end of month", "2026-08-31"],
  ])("%s -> %s", (input, expected) => {
    expect(parse(`Task ${input}`).due?.date).toBe(expected);
  });
});

describe("weekdays", () => {
  it("bare weekday picks the next occurrence, including today", () => {
    expect(parse("Task monday").due?.date).toBe("2026-08-03");
    expect(parse("Task friday").due?.date).toBe("2026-08-07");
  });

  it("'next' skips past today", () => {
    expect(parse("Task next monday").due?.date).toBe("2026-08-10");
  });

  it("handles abbreviations", () => {
    expect(parse("Task wed").due?.date).toBe("2026-08-05");
    expect(parse("Task thurs").due?.date).toBe("2026-08-06");
  });

  it("does not match a weekday inside a longer word", () => {
    const r = parse("Buy sunscreen and a satchel");
    expect(r.due).toBeNull();
    expect(r.content).toBe("Buy sunscreen and a satchel");
  });

  it("weekend resolves to Saturday", () => {
    expect(parse("Task this weekend").due?.date).toBe("2026-08-08");
    expect(parse("Task next weekend").due?.date).toBe("2026-08-15");
  });
});

describe("absolute dates", () => {
  it.each([
    ["2026-12-25", "2026-12-25"],
    ["jan 27", "2027-01-27"],
    ["january 27th", "2027-01-27"],
    ["dec 25", "2026-12-25"],
    ["27 jan", "2027-01-27"],
    ["25th of december", "2026-12-25"],
    ["sep 9 2027", "2027-09-09"],
  ])("%s -> %s", (input, expected) => {
    expect(parse(`Task ${input}`).due?.date).toBe(expected);
  });

  it("rolls a past month/day forward to next year", () => {
    expect(parse("Task mar 1").due?.date).toBe("2027-03-01");
  });

  it("respects the MDY/DMY setting", () => {
    const mdy = parseQuickAdd("Task 3/5", { now: NOW, timeZone: TZ, dateFormat: "MDY" });
    const dmy = parseQuickAdd("Task 3/5", { now: NOW, timeZone: TZ, dateFormat: "DMY" });
    expect(mdy.due?.date).toBe("2027-03-05");
    expect(dmy.due?.date).toBe("2027-05-03");
  });

  it("rejects impossible dates", () => {
    const r = parse("Task 2026-02-31");
    expect(r.due).toBeNull();
  });
});

describe("times", () => {
  it.each([
    ["at 5pm", "17:00"],
    ["5pm", "17:00"],
    ["at 5:30pm", "17:30"],
    ["17:00", "17:00"],
    ["at 9am", "09:00"],
    ["12pm", "12:00"],
    ["12am", "00:00"],
    ["noon", "12:00"],
    ["midnight", "00:00"],
  ])("%s -> %s", (input, expected) => {
    expect(parse(`Task ${input}`).due?.time).toBe(expected);
  });

  it("guesses am/pm for a bare hour", () => {
    expect(parse("Task at 5").due?.time).toBe("17:00");
    expect(parse("Task at 9").due?.time).toBe("09:00");
  });

  it("a time with no date means today", () => {
    const r = parse("Standup at 9am");
    expect(r.due?.date).toBe("2026-08-03");
    expect(r.content).toBe("Standup");
  });

  it("'tomorrow morning' attaches the named time to the date", () => {
    const r = parse("Gym tomorrow morning");
    expect(r.due?.date).toBe("2026-08-04");
    expect(r.due?.time).toBe("09:00");
  });

  it("ignores a bare 'morning' with no date", () => {
    const r = parse("Plan the morning routine");
    expect(r.due).toBeNull();
    expect(r.content).toBe("Plan the morning routine");
  });

  it("does not read 'at the office' as a time", () => {
    const r = parse("Meet Sam at the office");
    expect(r.due).toBeNull();
  });
});

describe("duration", () => {
  it("parses explicit durations", () => {
    expect(parse("Task for 2h").durationMinutes).toBe(120);
    expect(parse("Task for 45m").durationMinutes).toBe(45);
    expect(parse("Task for 90 minutes").durationMinutes).toBe(90);
  });

  it("derives start and duration from a time range", () => {
    const r = parse("Design review 3pm-4:30pm");
    expect(r.due?.time).toBe("15:00");
    expect(r.durationMinutes).toBe(90);
    expect(r.content).toBe("Design review");
  });

  it("ignores a bare numeric range", () => {
    const r = parse("Read pages 3-4");
    expect(r.durationMinutes).toBeNull();
    expect(r.content).toBe("Read pages 3-4");
  });
});

describe("priority", () => {
  it.each([
    ["p1", 1], ["p2", 2], ["p3", 3], ["p4", 4], ["!!1", 1],
  ])("%s -> %s", (input, expected) => {
    expect(parse(`Task ${input}`).priority).toBe(expected);
  });

  it("defaults to 4", () => {
    expect(parse("Task").priority).toBe(4);
  });

  it("does not match p1 inside a word", () => {
    expect(parse("Deploy to ec2p1x").priority).toBe(4);
  });
});

describe("deadline", () => {
  it("parses a braced deadline separately from the due date", () => {
    const r = parse("File taxes {apr 15} tomorrow");
    expect(r.deadline).toBe("2027-04-15");
    expect(r.due?.date).toBe("2026-08-04");
    expect(r.content).toBe("File taxes");
  });
});

describe("recurrence", () => {
  it("every day", () => {
    const r = parse("Vitamins every day");
    expect(r.due?.recurrence).toMatchObject({ freq: "daily", interval: 1 });
    expect(r.content).toBe("Vitamins");
  });

  it("every other week", () => {
    expect(parse("Task every other week").due?.recurrence).toMatchObject({
      freq: "weekly",
      interval: 2,
    });
  });

  it("every 3 days", () => {
    expect(parse("Task every 3 days").due?.recurrence).toMatchObject({
      freq: "daily",
      interval: 3,
    });
  });

  it("every monday", () => {
    const r = parse("Standup every monday");
    expect(r.due?.recurrence).toMatchObject({ freq: "weekly", weekdays: [1] });
    expect(r.due?.date).toBe("2026-08-03");
  });

  it("every mon, wed and fri", () => {
    expect(parse("Gym every mon, wed and fri").due?.recurrence).toMatchObject({
      freq: "weekly",
      weekdays: [1, 3, 5],
    });
  });

  it("every weekday", () => {
    expect(parse("Task every weekday").due?.recurrence).toMatchObject({
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it("every! marks completion-based recurrence", () => {
    expect(parse("Task every! 3 days").due?.recurrence).toMatchObject({
      freq: "daily",
      interval: 3,
      fromCompletion: true,
    });
  });

  it("every morning implies a time", () => {
    const r = parse("Meditate every morning");
    expect(r.due?.recurrence).toMatchObject({ freq: "daily" });
    expect(r.due?.time).toBe("09:00");
  });

  it("every jan 27 is yearly", () => {
    const r = parse("Renew domain every jan 27");
    expect(r.due?.recurrence).toMatchObject({ freq: "yearly", month: 1, monthDay: 27 });
    expect(r.due?.date).toBe("2027-01-27");
  });

  it("combines recurrence with a time", () => {
    const r = parse("Standup every weekday at 9:15am #Team");
    expect(r.content).toBe("Standup");
    expect(r.due?.time).toBe("09:15");
    expect(r.projectName).toBe("Team");
  });
});

describe("nextOccurrence", () => {
  const from = (key: string) => civilFromKey(key)!;
  const next = (r: Parameters<typeof nextOccurrence>[0], key: string) =>
    civilKey(nextOccurrence(r, from(key)));

  const rule = (over: Partial<Parameters<typeof nextOccurrence>[0]>) => ({
    freq: "daily" as const, interval: 1, weekdays: [], month: null,
    monthDay: null, fromCompletion: false, ...over,
  });

  it("advances daily rules", () => {
    expect(next(rule({ freq: "daily", interval: 3 }), "2026-08-03")).toBe("2026-08-06");
  });

  it("advances to the next listed weekday", () => {
    const r = rule({ freq: "weekly", weekdays: [1, 3, 5] });
    expect(next(r, "2026-08-03")).toBe("2026-08-05"); // Mon -> Wed
    expect(next(r, "2026-08-07")).toBe("2026-08-10"); // Fri -> next Mon
  });

  it("skips a week for every-other-weekday rules", () => {
    const r = rule({ freq: "weekly", weekdays: [1], interval: 2 });
    expect(next(r, "2026-08-03")).toBe("2026-08-17");
  });

  it("clamps monthly rules to short months", () => {
    const r = rule({ freq: "monthly", monthDay: 31 });
    expect(next(r, "2026-01-31")).toBe("2026-02-28");
  });

  it("advances yearly rules past the current date", () => {
    const r = rule({ freq: "yearly", month: 1, monthDay: 27 });
    expect(next(r, "2027-01-27")).toBe("2028-01-27");
  });
});
