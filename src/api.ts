import type {
  CalendarItem,
  GoogleAccountStatus,
  Project,
  Task,
} from "../shared/types.ts";

export interface Preferences {
  timeZone: string;
  dateFormat: "MDY" | "DMY";
}

export interface AppState {
  projects: Project[];
  tasks: Task[];
  preferences: Preferences;
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

  createTask: (text: string, timeZone: string) =>
    request<{ task: Task }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ text, timeZone }),
    }),

  updateTask: (id: string, patch: Record<string, unknown>) =>
    request<{ task: Task }>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  completeTask: (id: string) =>
    request<{ task: Task }>(`/api/tasks/${id}/complete`, { method: "POST" }),

  uncompleteTask: (id: string) =>
    request<{ task: Task }>(`/api/tasks/${id}/uncomplete`, { method: "POST" }),

  deleteTask: (id: string) =>
    request<void>(`/api/tasks/${id}`, { method: "DELETE" }),

  createProject: (name: string) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  reorderProjects: (ids: string[]) =>
    request<void>("/api/projects/order", {
      method: "PATCH",
      body: JSON.stringify({ ids }),
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

  disconnectGoogle: () =>
    request<GoogleAccountStatus>("/api/google/disconnect", { method: "POST" }),

  setCalendarEnabled: (id: string, enabled: boolean) =>
    request<GoogleAccountStatus>(`/api/google/calendars/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
};
