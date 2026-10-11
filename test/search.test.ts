import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { matchFields } from "../shared/search.ts";

describe("matchFields", () => {
    const fields = [
        { label: "title", text: "Book dentist" },
        { label: "notes", text: "Ask about the Dentist's hours" },
    ];

    it("reports the first field hit, how many others matched, and the hit's range", () => {
        expect(matchFields("DENTIST", fields)).toEqual({ field: "title", more: 1, text: "Book dentist", start: 5, end: 12 });
    });

    it("is null for a blank query or no hit", () => {
        expect(matchFields("  ", fields)).toBeNull();
        expect(matchFields("plumber", fields)).toBeNull();
    });

    it("excerpts long text around the hit", () => {
        const text = `${"a ".repeat(60)}needle${" b".repeat(60)}`;
        const m = matchFields("needle", [{ label: "notes", text }])!;
        expect(m.text.startsWith("…")).toBe(true);
        expect(m.text.endsWith("…")).toBe(true);
        expect(m.text.slice(m.start, m.end)).toBe("needle");
        expect(m.text.length).toBeLessThan(120);
    });
});

describe("global search", () => {
    it("finds tasks (done too), events and habit day notes, saying where each matched", async () => {
        const s = env.USER_DO.getByName("search-all");
        const { id } = await s.createHabit({ name: "Floss", description: "", freq: "daily", perWeek: null, weekdays: [] });
        const today = new Date().toISOString().slice(0, 10);
        await s.setHabitCheckin(id, today, "skipped", "the dentist said go easy");
        await s.createEvent({ title: "Check-up", description: "Dentist, 22 King St", startDate: today, startTime: null, endDate: today, endTime: null });
        const task = await s.createTask({ content: "Pay invoice", description: "includes dentist fee" });
        await s.completeTask(task.id, today);

        const r = await s.search("dentist");
        expect(r.tasks.map((x) => [x.kind === "task" && x.task.content, x.match.field])).toEqual([["Pay invoice", "notes"]]);
        expect(r.events.map((x) => x.match.field)).toEqual(["notes"]);
        expect(r.habits).toMatchObject([{ name: "Floss", day: today, match: { field: "day note" } }]);
    });
});
