import { addDays, civilFromDate, civilFromKey, civilKey, weekday, zonedToUtcMs } from "../shared/civil.ts";
import { nextOccurrence, parseQuickAdd } from "../shared/parser.ts";
import type { AppState, CalEvent, CalendarItem, EventInput, Project, Task } from "../shared/types.ts";

export function optimistically<T>(
    save: () => Promise<T>,
    onSaved: (result: T) => void,
    rollback: () => void,
    notify: (message: string | null) => void,
): Promise<void> {
    return save()
        .then((result) => {
            onSaved(result);
            notify(null);
        })
        .catch((e: Error) => {
            rollback();
            notify(e.message);
        });
}

/**
 * Stand-ins shown while a create or edit is still on its way to the server. They carry
 * a temporary id; the server's copy replaces them when it answers, or they are taken
 * back out if the save fails.
 */
export const tempId = () => `tmp:${crypto.randomUUID()}`;

/**
 * Adds a draft task for each line, the way the server will parse it. A "#name" that
 * matches no project gets a draft project too, so the sidebar and the task agree.
 * Throws when no line has any content, as the server would.
 */
export function withDraftTasks(
    state: AppState,
    lines: string[],
    { goalId, projectId }: { goalId?: string; projectId?: string },
): { state: AppState; taskIds: string[]; projectIds: string[] } {
    const { timeZone, dateFormat } = state.preferences;
    const now = new Date().toISOString();
    const projects = [...state.projects];
    const projectIds: string[] = [];
    const drafts: Task[] = [];
    let order = Math.max(0, ...state.tasks.map((t) => t.order));

    for (const line of lines) {
        const parsed = parseQuickAdd(line, { timeZone, dateFormat });
        if (!parsed.content) continue;

        // A "#project" typed in the text wins over the project being looked at.
        let project: Project | undefined = parsed.projectName
            ? projects.find((p) => p.name.toLowerCase() === parsed.projectName!.toLowerCase())
            : projects.find((p) => p.id === projectId) ?? projects.find((p) => p.isInbox);
        if (!project && parsed.projectName) {
            project = {
                id: tempId(),
                name: parsed.projectName,
                color: "slate",
                isInbox: false,
                order: projects.length,
                createdAt: now,
                pinned: false,
            };
            projects.push(project);
            projectIds.push(project.id);
        }

        drafts.push({
            id: tempId(),
            content: parsed.content,
            description: "",
            projectId: project?.id ?? "",
            priority: parsed.priority,
            due: parsed.due,
            deadline: parsed.deadline,
            durationMinutes: parsed.durationMinutes,
            goalId: goalId ?? null,
            completed: false,
            completedAt: null,
            order: ++order,
            createdAt: now,
            updatedAt: now,
        });
    }
    if (drafts.length === 0) throw new Error("task has no content");

    return {
        state: { ...state, projects, tasks: [...state.tasks, ...drafts] },
        taskIds: drafts.map((t) => t.id),
        projectIds,
    };
}

/** Takes drafts back out after a failed save. */
export function withoutDrafts(state: AppState, taskIds: string[], projectIds: string[]): AppState {
    return {
        ...state,
        tasks: state.tasks.filter((t) => !taskIds.includes(t.id)),
        projects: state.projects.filter((p) => !projectIds.includes(p.id)),
    };
}

const minutesOf = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
};

/** The calendar item the server will build for this event, so a draft sits where the real one will. */
export function eventItem(input: EventInput, id: string, timeZone: string): CalendarItem {
    const first = civilFromKey(input.startDate)!;
    const last = civilFromKey(input.endDate)!;
    const allDay = input.startTime === null || input.endTime === null;
    const start = allDay ? zonedToUtcMs(first, 0, timeZone) : zonedToUtcMs(first, minutesOf(input.startTime!), timeZone);
    const end = allDay ? zonedToUtcMs(addDays(last, 1), 0, timeZone) : zonedToUtcMs(last, minutesOf(input.endTime!), timeZone);
    const now = new Date().toISOString();
    const event: CalEvent = { id, ...input, createdAt: now, updatedAt: now };
    return {
        id: `event:${id}`,
        kind: "event",
        title: input.title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        allDay,
        event,
    };
}

export function withCompleted(state: AppState, task: Task): AppState {
    return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== task.id),
        completedThisWeek: state.completedThisWeek + 1,
        completedThisWeekByProject: {
            ...state.completedThisWeekByProject,
            [task.projectId]: (state.completedThisWeekByProject[task.projectId] ?? 0) + 1,
        },
        goals: task.goalId
            ? state.goals.map((g) => (g.id === task.goalId ? { ...g, stepsDone: g.stepsDone + 1 } : g))
            : state.goals,
    };
}

export function withUncompleted(state: AppState, task: Task, today: string): AppState {
    const day = civilFromKey(today)!;
    const monday = civilKey(addDays(day, -((weekday(day) + 6) % 7)));
    const doneOn = task.completedAt
        ? civilKey(civilFromDate(new Date(task.completedAt), state.preferences.timeZone))
        : today;
    const counts = doneOn >= monday && {
        completedThisWeek: state.completedThisWeek - 1,
        completedThisWeekByProject: {
            ...state.completedThisWeekByProject,
            [task.projectId]: (state.completedThisWeekByProject[task.projectId] ?? 1) - 1,
        },
    };
    return {
        ...state,
        ...counts,
        tasks: [...state.tasks.filter((t) => t.id !== task.id), { ...task, completed: false, completedAt: null }],
        goals: task.goalId
            ? state.goals.map((g) => (g.id === task.goalId ? { ...g, stepsDone: g.stepsDone - 1 } : g))
            : state.goals,
    };
}

export function rescheduled(task: Task, today: string): Task {
    const recurrence = task.due?.recurrence;
    if (!task.due || !recurrence) return task;
    const scheduled = civilFromKey(task.due.date)!;
    const from = recurrence.fromCompletion ? civilFromKey(today)! : scheduled;
    return { ...task, due: { ...task.due, date: civilKey(nextOccurrence(recurrence, from, scheduled)) } };
}
