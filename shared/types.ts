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
  /** YYYY-MM-DD in the user's timezone. */
  date: string;
  /** HH:MM 24h, or null for an all-day task. */
  time: string | null;
  recurrence: Recurrence | null;
  /** IANA zone the date/time was resolved in. */
  timeZone: string;
}

export interface Task {
  id: string;
  content: string;
  description: string;
  projectId: string;
  labels: string[];
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
}

/** A span of the raw input consumed by the parser, for UI highlighting. */
export interface ParsedToken {
  type:
    | "project"
    | "label"
    | "priority"
    | "date"
    | "time"
    | "recurrence"
    | "duration"
    | "deadline"
    | "assignee";
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
  labels: string[];
  priority: Priority;
  due: DueDate | null;
  deadline: string | null;
  durationMinutes: number | null;
  assignee: string | null;
  tokens: ParsedToken[];
}

/** A task or a Google Calendar event, normalised for the calendar view. */
export interface CalendarItem {
  id: string;
  kind: "task" | "gcal";
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
}

export interface GoogleAccountStatus {
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

/** The fixed views in the sidebar, in the order a new user sees them. */
export const NAV_KEYS = ["today", "upcoming", "inbox", "calendar"] as const;

export type NavKey = (typeof NAV_KEYS)[number];

export interface Preferences {
  timeZone: string;
  dateFormat: "MDY" | "DMY";
  /** Sidebar view order, always a permutation of NAV_KEYS. */
  navOrder: NavKey[];
}
