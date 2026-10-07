import { z } from "zod";
import { addDays, civilFromKey, zonedToUtcMs } from "../../shared/civil.ts";
import type { Task } from "../../shared/types.ts";
import * as schemas from "../schemas.ts";
import * as service from "../service.ts";
import type { UserDO } from "../user-do.ts";

/**
 * What the assistant can do, as one registry. Every tool goes through the
 * service layer, the same path as the HTTP routes, so validation, Inbox and
 * trash rules, and Google sync all apply. Nothing here touches SQL, which keeps
 * the Google tokens in the DO out of the model's reach.
 *
 * Kept free of anything chat-specific so an MCP server can expose the same list.
 */

export type Stub = DurableObjectStub<UserDO>;

export interface ToolContext {
    stub: Stub;
    timeZone: string;
}

export interface Tool {
    name: string;
    description: string;
    /** Writes wait for the user to approve them; reads run straight away. */
    kind: "read" | "write";
    args: z.ZodType;
    run(ctx: ToolContext, args: unknown): Promise<unknown>;
    /** Writes only: the line on the approval card. */
    summarize?(ctx: ToolContext, args: unknown): Promise<string>;
}

function tool<S extends z.ZodType>(def: {
    name: string;
    description: string;
    kind: "read" | "write";
    args: S;
    run(ctx: ToolContext, args: z.output<S>): Promise<unknown>;
    summarize?(ctx: ToolContext, args: z.output<S>): Promise<string>;
}): Tool {
    return def as Tool;
}

const none = z.object({});
const id = z.object({ id: z.string().min(1) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM").optional();

/** Only what the model needs to reason about a task; ids, never internals. */
const taskView = (t: Task) => ({
    id: t.id,
    content: t.content,
    description: t.description.slice(0, 200) || undefined,
    projectId: t.projectId,
    priority: t.priority,
    due: t.due && { date: t.due.date, time: t.due.time, recurring: t.due.recurrence !== null },
    deadline: t.deadline ?? undefined,
    goalId: t.goalId ?? undefined,
    completed: t.completed || undefined,
});

async function taskName(stub: Stub, taskId: string): Promise<string> {
    const task = await stub.getTask(taskId);
    return task ? `"${task.content}"` : `task ${taskId}`;
}

async function goalName(stub: Stub, goalId: string): Promise<string> {
    const goal = (await stub.listGoals()).find((g) => g.id === goalId);
    return goal ? `"${goal.title}"` : `goal ${goalId}`;
}

async function habitName(stub: Stub, habitId: string): Promise<string> {
    const habit = (await stub.listHabits()).find((h) => h.id === habitId);
    return habit ? `"${habit.name}"` : `habit ${habitId}`;
}

const when = (e: { startDate: string; startTime: string | null }) =>
    e.startTime ? `${e.startDate} ${e.startTime}` : e.startDate;

export const tools: Tool[] = [
    // ---- Reads ---------------------------------------------------------------

    tool({
        name: "get_overview",
        description:
            "Everything open right now: projects, open tasks, goals and habits, with their ids. Call this before acting on anything the user names.",
        kind: "read",
        args: none,
        async run({ stub }) {
            const [projects, tasks, goals, habits] = await Promise.all([
                stub.listProjects(),
                stub.listTasks(),
                stub.listGoals(),
                stub.listHabits(),
            ]);
            return {
                projects: projects.map((p) => ({ id: p.id, name: p.name, isInbox: p.isInbox || undefined })),
                tasks: tasks.map(taskView),
                goals: goals.map((g) => ({
                    id: g.id,
                    title: g.title,
                    horizon: g.horizon,
                    current: g.current,
                    target: g.target,
                    unit: g.unit || undefined,
                    deadline: g.deadline,
                    stepsDone: g.stepsDone,
                })),
                habits: habits.map((h) => ({
                    id: h.id,
                    name: h.name,
                    freq: h.freq,
                    perWeek: h.perWeek ?? undefined,
                    weekdays: h.weekdays.length ? h.weekdays : undefined,
                    today: h.today,
                    stats: h.stats,
                })),
            };
        },
    }),

    tool({
        name: "list_completed_tasks",
        description: "Completed tasks, newest first, 50 at a time. Pass `before` (a completedAt from the last page) for older ones.",
        kind: "read",
        args: z.object({ before: z.string().optional(), projectId: z.string().optional() }),
        async run({ stub }, { before, projectId }) {
            const { tasks, more } = await service.listCompletedTasks(stub, before, projectId);
            return { tasks: tasks.map((t) => ({ ...taskView(t), completedAt: t.completedAt })), more };
        },
    }),

    tool({
        name: "get_calendar",
        description:
            "Everything on the calendar between two dates, inclusive: timed tasks, the user's own events and Google Calendar events.",
        kind: "read",
        args: z.object({ from: date, to: date }),
        async run({ stub, timeZone }, { from, to }) {
            const start = civilFromKey(from);
            const end = civilFromKey(to);
            if (!start || !end) throw new service.ServiceError(400, "from and to must be real dates");
            const items = await service.calendarItems(
                stub,
                new Date(zonedToUtcMs(start, 0, timeZone)).toISOString(),
                new Date(zonedToUtcMs(addDays(end, 1), 0, timeZone)).toISOString(),
            );
            // Calendar ids carry a "task:" or "event:" prefix the other tools don't take.
            // Google ids stay whole: nothing here can change those.
            return items.map((i) => (i.kind === "gcal" ? i : { ...i, id: i.id.slice(i.kind.length + 1) }));
        },
    }),

    tool({
        name: "get_habits_month",
        description: "Every habit's check-ins for one month (YYYY-MM, default this month), keyed by habit id.",
        kind: "read",
        args: z.object({ month }),
        run: ({ stub }, args) => service.getHabitsMonth(stub, args.month),
    }),

    tool({
        name: "get_habit",
        description: "One habit with its stats and check-ins for a month (YYYY-MM, default this month).",
        kind: "read",
        args: z.object({ id: z.string().min(1), month }),
        run: ({ stub }, args) => service.getHabit(stub, args.id, args.month),
    }),

    tool({
        name: "get_trash",
        description: "Deleted projects and tasks that can still be restored.",
        kind: "read",
        args: none,
        run: ({ stub }) => service.getTrash(stub),
    }),

    // ---- Writes --------------------------------------------------------------

    tool({
        name: "quick_add_task",
        description:
            "Add a task from natural-language text, parsed exactly like the app's quick-add box. Dates and times ('tomorrow 3pm', 'every monday'), '#Project', 'p1'-'p4' priority and '{deadline}' all go in the text. projectId files it there unless the text names a #project.",
        kind: "write",
        args: z.object({
            text: z.string().trim().min(1),
            projectId: z.string().min(1).optional(),
            goalId: z.string().min(1).optional(),
        }),
        run: ({ stub, timeZone }, a) => service.quickAddTask(stub, a.text, timeZone, a.goalId, a.projectId),
        summarize: async (_, a) => `Add task "${a.text}"`,
    }),

    tool({
        name: "update_task",
        description: "Change fields on a task. Only send the fields that change; null clears a field.",
        kind: "write",
        args: z.object({ id: z.string().min(1), patch: schemas.taskPatchBody }),
        run: ({ stub }, a) => service.updateTask(stub, a.id, a.patch),
        summarize: async ({ stub }, a) =>
            `Update ${await taskName(stub, a.id)}: ${Object.keys(a.patch).join(", ") || "nothing"}`,
    }),

    tool({
        name: "complete_task",
        description: "Mark a task done. A recurring task moves to its next date instead.",
        kind: "write",
        args: id,
        run: ({ stub }, a) => service.completeTask(stub, a.id),
        summarize: async ({ stub }, a) => `Complete ${await taskName(stub, a.id)}`,
    }),

    tool({
        name: "uncomplete_task",
        description: "Put a completed task back on the list.",
        kind: "write",
        args: id,
        run: ({ stub }, a) => service.uncompleteTask(stub, a.id),
        summarize: async ({ stub }, a) => `Reopen ${await taskName(stub, a.id)}`,
    }),

    tool({
        name: "delete_task",
        description: "Move a task to the trash, where it can be restored.",
        kind: "write",
        args: id,
        run: ({ stub }, a) => service.deleteTask(stub, a.id),
        summarize: async ({ stub }, a) => `Move ${await taskName(stub, a.id)} to the trash`,
    }),

    tool({
        name: "create_event",
        description:
            "Add a calendar event. Dates are YYYY-MM-DD and times HH:MM (24h) in the user's zone; null times make it all-day.",
        kind: "write",
        args: schemas.eventBody,
        run: ({ stub }, a) => service.createEvent(stub, a),
        summarize: async (_, a) => `Add event "${a.title}" on ${when(a)}`,
    }),

    tool({
        name: "update_event",
        description: "Replace a calendar event. Send every field, not just the changed ones.",
        kind: "write",
        args: z.object({ id: z.string().min(1), event: schemas.eventBody }),
        run: ({ stub }, a) => service.updateEvent(stub, a.id, a.event),
        summarize: async (_, a) => `Change event "${a.event.title}" to ${when(a.event)}`,
    }),

    tool({
        name: "delete_event",
        description: "Delete one of the user's calendar events. `title` is shown to the user when they confirm.",
        kind: "write",
        args: z.object({ id: z.string().min(1), title: z.string() }),
        run: ({ stub }, a) => service.deleteEvent(stub, a.id),
        summarize: async (_, a) => `Delete event "${a.title}"`,
    }),

    tool({
        name: "create_goal",
        description:
            "Add a goal. target null means a yes/no goal; deadline is YYYY-MM-DD; horizon is short, medium or long.",
        kind: "write",
        args: schemas.goalBody,
        run: ({ stub }, a) => service.createGoal(stub, a),
        summarize: async (_, a) => `Add goal "${a.title}" by ${a.deadline}`,
    }),

    tool({
        name: "update_goal",
        description: "Replace a goal's details. Send every field, copying unchanged ones from get_overview.",
        kind: "write",
        args: z.object({ id: z.string().min(1), goal: schemas.goalBody }),
        run: ({ stub }, a) => service.updateGoal(stub, a.id, a.goal),
        summarize: async ({ stub }, a) => `Update goal ${await goalName(stub, a.id)}`,
    }),

    tool({
        name: "set_goal_progress",
        description: "Set how far along a goal is (its `current` value, in the goal's unit).",
        kind: "write",
        args: z.object({ id: z.string().min(1), current: schemas.goalProgressBody.shape.current }),
        run: ({ stub }, a) => service.setGoalProgress(stub, a.id, a.current),
        summarize: async ({ stub }, a) => `Set ${await goalName(stub, a.id)} progress to ${a.current}`,
    }),

    tool({
        name: "set_habit_checkin",
        description:
            "Log a habit for a day (YYYY-MM-DD, today or earlier): status done or skipped, or null to clear it.",
        kind: "write",
        args: schemas.habitCheckinBody.extend({ id: z.string().min(1), day: date }),
        run: ({ stub }, a) => service.setHabitCheckin(stub, a.id, a.day, a.status, a.note),
        summarize: async ({ stub }, a) =>
            `${a.status === null ? "Clear" : a.status === "done" ? "Check off" : "Skip"} ${await habitName(stub, a.id)} on ${a.day}`,
    }),

    tool({
        name: "create_project",
        description: "Add a project.",
        kind: "write",
        args: schemas.createProjectBody,
        run: ({ stub }, a) => service.createProject(stub, a.name, a.color),
        summarize: async (_, a) => `Add project "${a.name}"`,
    }),
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));
