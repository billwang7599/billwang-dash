import { z } from "zod";

/**
 * Request body shapes for /api. Hono's `c.req.json<T>()` only casts, so a body
 * reaching a typed method was an unchecked claim; these parse it instead.
 *
 * Writes only, deliberately. Rows read back out of the DO are repaired rather
 * than validated — on a read there is nothing useful to do with a rejection,
 * because the bad data is already stored.
 */

const nonEmpty = z.string().trim().min(1, "is required");

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "expected an IANA time zone");

// Matches the parser's own output shape; see Recurrence in shared/types.ts.
const recurrence = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.int().positive(),
  weekdays: z.array(z.int().min(0).max(6)),
  month: z.int().min(1).max(12).nullable(),
  monthDay: z.int().min(1).max(31).nullable(),
  fromCompletion: z.boolean(),
});

const dueDate = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "expected HH:MM")
    .nullable(),
  recurrence: recurrence.nullable(),
});

export const quickAddBody = z.object({
  text: nonEmpty,
  timeZone: timeZone.optional(),
});

/**
 * Every field optional: this is a PATCH, and updateTask distinguishes "absent"
 * from "explicitly null" to decide which columns to touch.
 */
export const taskPatchBody = z.object({
  content: nonEmpty.optional(),
  description: z.string().optional(),
  projectId: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  due: dueDate.nullable().optional(),
  deadline: z.string().nullable().optional(),
  durationMinutes: z.int().positive().nullable().optional(),
});

export const createProjectBody = z.object({
  name: nonEmpty,
  color: z.string().optional(),
});

export const preferencesBody = z.object({
  timeZone: timeZone.optional(),
  dateFormat: z.enum(["MDY", "DMY"]).optional(),
});

export const calendarToggleBody = z.object({
  enabled: z.boolean(),
});

export const pinnedBody = z.object({
  pinned: z.boolean(),
});
