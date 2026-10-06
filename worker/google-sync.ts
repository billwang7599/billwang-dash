import { addDays, civilFromKey, civilKey, minutesToTime, parseTimeToMinutes } from "../shared/civil.ts";
import type { Task } from "../shared/types.ts";
import { GoogleApiError, type GoogleEventPayload } from "./google.ts";

/**
 * Pure pieces of the dash -> Google sync: what the event for a task should be,
 * its stable id, a fingerprint to skip no-op pushes, and how to treat errors.
 * The Durable Object owns the outbox and the API calls.
 */

/** Matches the in-app calendar's default for a task without a duration. */
const DEFAULT_DURATION_MINUTES = 30;

/**
 * Deterministic and valid as a Google event id (base32hex: 0-9, a-v). A retried
 * insert therefore collides with 409 instead of creating a duplicate.
 */
export function eventIdForTask(taskId: string): string {
    return `dash${taskId.replace(/-/g, "").toLowerCase()}`;
}

/**
 * The Google event a task should have, or null if it should have none: done,
 * or no due date. Whether the task is trashed is the caller's call, since that
 * needs the project too.
 *
 * Times are wall-clock in `timeZone` (the profile zone), matching how tasks
 * float. A recurring task is one event at its current due date; completing it
 * rolls the date and the event follows.
 */
export function eventForTask(
    task: Task,
    timeZone: string,
    appOrigin: string,
): GoogleEventPayload | null {
    if (task.completed || !task.due) return null;
    const day = civilFromKey(task.due.date);
    if (!day) return null;

    const link = `${appOrigin.replace(/\/+$/, "")}/app`;
    const description = [task.description.trim(), `Open in dash: ${link}`]
        .filter(Boolean)
        .join("\n\n");
    const base = {
        summary: task.content,
        description,
        extendedProperties: { private: { dashTaskId: task.id } },
    };

    if (task.due.time === null) {
        return {
            ...base,
            start: { date: task.due.date },
            end: { date: civilKey(addDays(day, 1)) },
            // An all-day reminder shouldn't make you look busy.
            transparency: "transparent",
        };
    }

    const startMinutes = parseTimeToMinutes(task.due.time);
    const endTotal = startMinutes + (task.durationMinutes ?? DEFAULT_DURATION_MINUTES);
    const endDay = addDays(day, Math.floor(endTotal / 1440));
    return {
        ...base,
        start: {
            dateTime: `${task.due.date}T${minutesToTime(startMinutes)}:00`,
            timeZone,
        },
        end: {
            dateTime: `${civilKey(endDay)}T${minutesToTime(endTotal % 1440)}:00`,
            timeZone,
        },
    };
}

/** Stable across key order, so an unchanged task hashes the same and is skipped. */
export async function fingerprint(payload: GoogleEventPayload): Promise<string> {
    const canonical = JSON.stringify(payload, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
    );
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ErrorKind =
    | "retry" // transient: back off and try again
    | "conflict" // 409: the event id already exists
    | "gone" // 404/410: the event or calendar no longer exists
    | "reauth" // the grant is missing or revoked; stop and ask the user
    | "fatal"; // this task can't be pushed; drop it rather than loop

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

export function classifyError(err: unknown): ErrorKind {
    if (!(err instanceof GoogleApiError)) return "retry"; // network failure
    if (err.status === 409) return "conflict";
    if (err.status === 404 || err.status === 410) return "gone";
    if (err.status === 401) return "reauth";
    if (err.status === 403) {
        return err.reason && RATE_REASONS.has(err.reason) ? "retry" : "reauth";
    }
    if (err.status === 429 || err.status >= 500) return "retry";
    return "fatal";
}

/** 1 min, 2, 4 ... capped at an hour. */
export function backoffMs(attempts: number): number {
    return Math.min(60_000 * 2 ** attempts, 3_600_000);
}
