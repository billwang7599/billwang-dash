import { z } from "zod";
import { addMonths, civilFromKey, civilKey, diffDays } from "./civil.ts";

/**
 * Goals, written SMART: a specific title, a way to tell it's done (measurable),
 * a reason why (relevant), and a deadline (time-bound). Achievable is the
 * writer's call.
 *
 * Measurable doesn't have to mean a number. A goal with no target is yes/no
 * ("Read Dune"): its current is 0 or 1, so the same done rule covers both.
 *
 * The horizon is picked by hand and stays put. horizonFor() says which one a
 * deadline suggests, so the editor can warn about a mismatch without blocking it.
 */

export const HORIZONS = ["short", "medium", "long"] as const;
export type Horizon = (typeof HORIZONS)[number];

export const HORIZON_LABELS: Record<Horizon, string> = {
    short: "Short term",
    medium: "Medium term",
    long: "Long term",
};

export const HORIZON_HINTS: Record<Horizon, string> = {
    short: "under 3 months",
    medium: "3 to 12 months",
    long: "a year or more",
};

/** Where short ends and medium starts, and where medium ends and long starts. */
const SHORT_MONTHS = 3;
const LONG_MONTHS = 12;

/**
 * What a create or edit sends. The Worker parses request bodies with this and
 * the editor checks its form against it.
 */
export const goalInputSchema = z
    .object({
        title: z.string().trim().min(1, "is required").max(100),
        why: z.string().max(1000).optional(),
        horizon: z.enum(HORIZONS),
        target: z.number().positive("must be more than 0").max(1e9).nullable().optional(),
        current: z.number().min(0).max(1e9).optional(),
        unit: z.string().max(30).optional(),
        deadline: z.string().refine((d) => civilFromKey(d) !== null, "must look like 2026-12-31"),
    })
    .transform((g) => ({
        title: g.title,
        why: g.why?.trim() ?? "",
        horizon: g.horizon,
        target: g.target ?? null,
        current: g.current ?? 0,
        unit: g.unit?.trim() ?? "",
        deadline: g.deadline,
    }));

export type GoalInput = z.output<typeof goalInputSchema>;

export interface Goal extends GoalInput {
    id: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
    /** Steps (linked tasks) completed so far. */
    stepsDone: number;
}

type Measured = { current: number; target: number | null };

/** 0 to 1. A yes/no goal is all or nothing. */
export const progress = (g: Measured) => Math.min(1, Math.max(0, g.current / (g.target ?? 1)));

export const isDone = (g: Measured) => g.current >= (g.target ?? 1);

/** The horizon a deadline falls in, counted from today. A past deadline is short. */
export function horizonFor(today: string, deadline: string): Horizon {
    const from = civilFromKey(today)!;
    if (deadline < civilKey(addMonths(from, SHORT_MONTHS))) return "short";
    if (deadline < civilKey(addMonths(from, LONG_MONTHS))) return "medium";
    return "long";
}

/** A warning when the deadline suggests another horizon, else null. Never blocks a save. */
export function horizonMismatch(horizon: Horizon, today: string, deadline: string): string | null {
    if (!civilFromKey(deadline)) return null;
    const fits = horizonFor(today, deadline);
    if (fits === horizon) return null;
    return `That deadline is ${HORIZON_HINTS[fits]} away, which reads as ${HORIZON_LABELS[fits].toLowerCase()}.`;
}

/** Negative once the deadline has passed. */
export const daysLeft = (today: string, deadline: string) =>
    diffDays(civilFromKey(today)!, civilFromKey(deadline)!);
