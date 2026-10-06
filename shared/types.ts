/** Types shared between the Worker, the Durable Object, and the React client. */

/** 1 = urgent (Todoist p1) ... 4 = none (default). */
export type Priority = 1 | 2 | 3 | 4;

type Frequency = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
    freq: Frequency;
    /** "every 3 weeks" -> 3 */
    interval: number;
    /** For weekly rules: 0 = Sunday ... 6 = Saturday. Empty means "same weekday". */
    weekdays: number[];
    /** For yearly rules pinned to a date, e.g. "every jan 27". */
    month: number | null;
    monthDay: number | null;
    /**
     * Todoist's `every!` form: the next occurrence is computed from the date the
     * task was completed rather than from its scheduled date.
     */
    fromCompletion: boolean;
}

export interface DueDate {
    /** YYYY-MM-DD, read in the user's current time zone (floating, not pinned). */
    date: string;
    /** HH:MM 24h, or null for an all-day task. */
    time: string | null;
    recurrence: Recurrence | null;
}

export interface Task {
    id: string;
    content: string;
    description: string;
    projectId: string;
    priority: Priority;
    due: DueDate | null;
    /** Hard deadline (Todoist `{jan 27}`), separate from when you plan to do it. */
    deadline: string | null;
    durationMinutes: number | null;
    completed: boolean;
    completedAt: string | null;
    order: number;
    createdAt: string;
    updatedAt: string;
}

export interface Project {
    id: string;
    name: string;
    color: string;
    isInbox: boolean;
    order: number;
    /** ISO timestamp, or "" for a project created before this field existed. */
    createdAt: string;
    pinned: boolean;
}

export interface TrashedProject extends Project {
    deletedAt: string;
    /** Tasks that went to the trash with it. */
    taskCount: number;
}

/** A task trashed on its own; tasks trashed with a project show under that project. */
export interface TrashedTask extends Task {
    deletedAt: string;
}

export interface Trash {
    projects: TrashedProject[];
    tasks: TrashedTask[];
}

/** A span of the raw input consumed by the parser, for UI highlighting. */
export interface ParsedToken {
    type:
        | "project"
        | "priority"
        | "date"
        | "time"
        | "recurrence"
        | "duration"
        | "deadline";
    /** The exact matched text. */
    text: string;
    start: number;
    end: number;
}

export interface ParsedQuickAdd {
    /** Input with every recognised token stripped out. */
    content: string;
    raw: string;
    projectName: string | null;
    priority: Priority;
    due: DueDate | null;
    deadline: string | null;
    durationMinutes: number | null;
    tokens: ParsedToken[];
}

/** A task or a Google Calendar event, normalised for the calendar view. */
/**
 * An event owned by dash, drawn on the calendar next to tasks and Google events.
 * Like tasks, times are floating wall-clock in the user's zone. All-day events have
 * null times and an inclusive end date; timed events may end on a later day.
 */
export interface CalEvent {
    id: string;
    title: string;
    description: string;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    createdAt: string;
    updatedAt: string;
}

export type EventInput = Pick<
    CalEvent,
    "title" | "description" | "startDate" | "startTime" | "endDate" | "endTime"
>;

export interface CalendarItem {
    id: string;
    kind: "task" | "gcal" | "event";
    title: string;
    /** ISO instant. */
    start: string;
    /** ISO instant. */
    end: string;
    allDay: boolean;
    /** Present on tasks. */
    priority?: Priority;
    completed?: boolean;
    projectId?: string;
    /** Present on Google Calendar events. */
    calendarId?: string;
    color?: string;
    htmlLink?: string;
    location?: string;
    description?: string;
    /** The Google calendar's name, for the details view. */
    calendarName?: string;
    /** Present on dash events: the wall-clock fields the editor needs. */
    event?: CalEvent;
}

export interface GooglePushStatus {
    enabled: boolean;
    /** Tasks waiting to be pushed. */
    pending: number;
    /** Why syncing stopped, if it did. */
    error: string | null;
}

export interface GoogleAccountStatus {
    /** Whether the grant includes write access to dash's own calendar. */
    canWrite: boolean;
    push: GooglePushStatus;
    connected: boolean;
    email: string | null;
    connectedAt: string | null;
    lastSyncedAt: string | null;
    calendars: GoogleCalendarSummary[];
}

export interface GoogleCalendarSummary {
    id: string;
    summary: string;
    color: string;
    primary: boolean;
    enabled: boolean;
}

export interface Preferences {
    timeZone: string;
    /** False until the zone is chosen or auto-detected; "UTC" alone cannot say. */
    timeZoneSet: boolean;
    dateFormat: "MDY" | "DMY";
}
