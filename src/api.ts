import type {
    CalEvent,
    CalendarItem,
    EventInput,
    GoogleAccountStatus,
    Preferences,
    Project,
    ProjectColor,
    Task,
    Trash,
} from "../shared/types.ts";
import type { Goal, GoalInput } from "../shared/goals.ts";
import type { DayStatus, HabitDay, HabitDetail, HabitInput, HabitSummary } from "../shared/habits.ts";

export type { Preferences };

export interface AppState {
    projects: Project[];
    tasks: Task[];
    preferences: Preferences;
    habits: HabitSummary[];
    goals: Goal[];
    /** Tasks completed since Monday in the user's zone. */
    completedThisWeek: number;
    /** The same, per project id; projects with none are left out. */
    completedThisWeekByProject: Record<string, number>;
    user: { id: string; email: string; name: string | null; isAdmin: boolean };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
    });

    if (res.status === 204) return undefined as T;

    // The Access session expired mid-visit. A fresh top-level request is what
    // re-triggers the login flow; the SPA cannot do it from a fetch.
    if (res.status === 401) {
        window.location.reload();
        throw new Error("Session expired — signing you back in.");
    }

    if (!res.ok) {
        // Error bodies are best-effort: a failure from the edge rather than the
        // Worker may not be JSON at all.
        const detail = await res
            .json()
            .then((b) => (b as { error?: string }).error)
            .catch(() => null);
        throw new Error(detail ?? `Request failed (${res.status})`);
    }
    return (await res.json()) as T;
}

export const api = {
    getState: () => request<AppState>("/api/state"),

    /** `goalId` adds the task as a step toward that goal; `projectId` files it there unless the text names a #project. */
    createTask: (text: string, timeZone: string, goalId?: string, projectId?: string) =>
        request<{ task: Task }>("/api/tasks", {
            method: "POST",
            body: JSON.stringify({ text, timeZone, goalId, projectId }),
        }),

    importTasks: (text: string, timeZone: string, projectId?: string) =>
        request<{ created: Task[]; skipped: { line: string; reason: string }[] }>(
            "/api/tasks/import",
            { method: "POST", body: JSON.stringify({ text, timeZone, projectId }) },
        ),

    updateTask: (id: string, patch: Record<string, unknown>) =>
        request<{ task: Task }>(`/api/tasks/${id}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
        }),

    completeTask: (id: string) =>
        request<{ task: Task }>(`/api/tasks/${id}/complete`, { method: "POST" }),

    /** Most recent first; pass the last task's completedAt for the next page. */
    listCompleted: (before?: string, projectId?: string) => {
        const query = new URLSearchParams();
        if (before) query.set("before", before);
        if (projectId) query.set("project", projectId);
        return request<{ tasks: Task[]; more: boolean }>(`/api/tasks/completed${query.size ? `?${query}` : ""}`);
    },

    uncompleteTask: (id: string) =>
        request<{ task: Task }>(`/api/tasks/${id}/uncomplete`, { method: "POST" }),

    deleteTask: (id: string) =>
        request<void>(`/api/tasks/${id}`, { method: "DELETE" }),

    createEvent: (input: EventInput) =>
        request<{ event: CalEvent }>("/api/events", { method: "POST", body: JSON.stringify(input) }),

    updateEvent: (id: string, input: EventInput) =>
        request<{ event: CalEvent }>(`/api/events/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

    deleteEvent: (id: string) => request<void>(`/api/events/${id}`, { method: "DELETE" }),

    /** Every habit's check-ins for one month, keyed by habit id. */
    getHabitsMonth: (month?: string) =>
        request<{ month: string; days: Record<string, HabitDay[]> }>(`/api/habits${month ? `?month=${month}` : ""}`),

    getHabit: (id: string, month?: string) =>
        request<HabitDetail>(`/api/habits/${id}${month ? `?month=${month}` : ""}`),

    createHabit: (input: HabitInput) =>
        request<{ habit: HabitSummary }>("/api/habits", { method: "POST", body: JSON.stringify(input) }),

    updateHabit: (id: string, input: HabitInput) =>
        request<{ habit: HabitSummary }>(`/api/habits/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

    deleteHabit: (id: string) => request<void>(`/api/habits/${id}`, { method: "DELETE" }),

    /** `status: null` clears the day. `note` omitted keeps the existing note. */
    setCheckin: (id: string, day: string, status: DayStatus | null, note?: string) =>
        request<{ habit: HabitSummary }>(`/api/habits/${id}/checkins/${day}`, {
            method: "PUT",
            body: JSON.stringify(note === undefined ? { status } : { status, note }),
        }),

    createGoal: (input: GoalInput) =>
        request<{ goal: Goal }>("/api/goals", { method: "POST", body: JSON.stringify(input) }),

    updateGoal: (id: string, input: GoalInput) =>
        request<{ goal: Goal }>(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

    setGoalProgress: (id: string, current: number) =>
        request<{ goal: Goal }>(`/api/goals/${id}/progress`, {
            method: "PUT",
            body: JSON.stringify({ current }),
        }),

    deleteGoal: (id: string) => request<void>(`/api/goals/${id}`, { method: "DELETE" }),

    getTrash: () => request<Trash>("/api/trash"),

    restoreTrashedProject: (id: string) =>
        request<{ project: Project }>(`/api/trash/projects/${id}/restore`, { method: "POST" }),

    restoreTrashedTask: (id: string) =>
        request<{ task: Task }>(`/api/trash/tasks/${id}/restore`, { method: "POST" }),

    purgeTrashedProject: (id: string) =>
        request<void>(`/api/trash/projects/${id}`, { method: "DELETE" }),

    purgeTrashedTask: (id: string) =>
        request<void>(`/api/trash/tasks/${id}`, { method: "DELETE" }),

    emptyTrash: () => request<void>("/api/trash", { method: "DELETE" }),

    createProject: (name: string) =>
        request<{ project: Project }>("/api/projects", {
            method: "POST",
            body: JSON.stringify({ name }),
        }),

    deleteProject: (id: string) =>
        request<void>(`/api/projects/${id}`, { method: "DELETE" }),

    setProjectColor: (id: string, color: ProjectColor) =>
        request<{ project: Project }>(`/api/projects/${id}/color`, {
            method: "PATCH",
            body: JSON.stringify({ color }),
        }),

    setProjectPinned: (id: string, pinned: boolean) =>
        request<{ project: Project }>(`/api/projects/${id}/pinned`, {
            method: "PATCH",
            body: JSON.stringify({ pinned }),
        }),

    setPreferences: (prefs: Partial<Preferences>) =>
        request<{ preferences: Preferences }>("/api/preferences", {
            method: "PATCH",
            body: JSON.stringify(prefs),
        }),

    calendar: (startISO: string, endISO: string) =>
        request<{ items: CalendarItem[] }>(
            `/api/calendar?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
        ),

    googleStatus: () => request<GoogleAccountStatus>("/api/google/status"),

    /** Refetch Google events now rather than waiting for the cache to go stale. */
    syncGoogle: () => request<GoogleAccountStatus>("/api/google/sync", { method: "POST" }),

    disconnectGoogle: () =>
        request<GoogleAccountStatus>("/api/google/disconnect", { method: "POST" }),

    setGooglePush: (enabled: boolean) =>
        request<GoogleAccountStatus>("/api/google/push", {
            method: "POST",
            body: JSON.stringify({ enabled }),
        }),

    setCalendarEnabled: (id: string, enabled: boolean) =>
        request<GoogleAccountStatus>(`/api/google/calendars/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled }),
        }),
};
