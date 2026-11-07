import { z } from "zod";
import { civilFromKey } from "./civil.ts";
import { HORIZONS } from "./goals.ts";

// Kept out of goals.ts so zod stays out of the app's first chunk.
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
