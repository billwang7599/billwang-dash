import { MAX_RESULTS_PER_KIND, matchFields, type SearchResult, type SearchResults } from "../../shared/search.ts";
import { listEvents } from "./events.ts";
import { listHabits } from "./habits.ts";
import { listProjects } from "./projects.ts";
import { listTasks } from "./tasks.ts";

/**
 * Global search over tasks (done ones too), dash's own events and habits. The data is one
 * person's, so each kind is read whole and matched with shared/search.ts rather than
 * indexed; a few thousand rows is nothing for the Durable Object's local SQLite.
 */
export function search(sql: SqlStorage, today: string, query: string): SearchResults {
    const projects = new Map(listProjects(sql).map((p) => [p.id, p.name]));

    const tasks = listTasks(sql, { includeCompleted: true }).flatMap((task): SearchResult[] => {
        const match = matchFields(query, [
            { label: "title", text: task.content },
            { label: "notes", text: task.description },
            { label: "project", text: projects.get(task.projectId) ?? "" },
        ]);
        return match ? [{ kind: "task", task, match }] : [];
    });

    const events = listEvents(sql).flatMap((event): SearchResult[] => {
        const match = matchFields(query, [
            { label: "title", text: event.title },
            { label: "notes", text: event.description },
        ]);
        return match ? [{ kind: "event", event, match }] : [];
    });

    const notes = sql
        .exec<{ habit_id: string; day: string; note: string }>(
            "SELECT habit_id, day, note FROM habit_checkins WHERE note != '' ORDER BY day DESC",
        )
        .toArray();
    const habits = listHabits(sql, today).flatMap((habit): SearchResult[] => {
        const own = matchFields(query, [
            { label: "title", text: habit.name },
            { label: "notes", text: habit.description },
        ]);
        if (own) return [{ kind: "habit", id: habit.id, name: habit.name, day: null, match: own }];
        for (const n of notes) {
            if (n.habit_id !== habit.id) continue;
            const match = matchFields(query, [{ label: "day note", text: n.note }]);
            if (match) return [{ kind: "habit", id: habit.id, name: habit.name, day: n.day, match }];
        }
        return [];
    });

    return {
        tasks: tasks.slice(0, MAX_RESULTS_PER_KIND),
        events: events.slice(0, MAX_RESULTS_PER_KIND),
        habits: habits.slice(0, MAX_RESULTS_PER_KIND),
    };
}
