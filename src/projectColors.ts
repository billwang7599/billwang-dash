import { PROJECT_COLORS, type Project, type ProjectColor } from "../shared/types.ts";

/** Card colours handed out by order, to projects without a picked one and to habits and goals. Tokens live in app.css. */
const PALETTE = ["mustard", "lav", "sage", "terra", "rose", "olive", "sky"];

/** The i-th card colour, wrapping round the palette. */
export const cardColor = (i: number) => `var(--c-${PALETTE[i % PALETTE.length]})`;

/** A picked colour name as a CSS value. */
export const colorValue = (name: ProjectColor) => `var(--c-${name})`;

const isPicked = (color: string): color is ProjectColor => (PROJECT_COLORS as readonly string[]).includes(color);

/**
 * Each project's card colour as a CSS value: the one picked for it if any, otherwise
 * one by sidebar order (projects made before colours could be picked say "slate").
 * Inbox is stone unless picked.
 */
export function projectColors(projects: Project[]): Map<string, string> {
    const colors = new Map<string, string>();
    const ordered = projects.filter((p) => !p.isInbox).sort((a, b) => a.order - b.order);
    ordered.forEach((p, i) => colors.set(p.id, isPicked(p.color) ? colorValue(p.color) : cardColor(i)));
    for (const p of projects) if (p.isInbox) colors.set(p.id, isPicked(p.color) ? colorValue(p.color) : "var(--c-stone)");
    return colors;
}

/** Each goal's card colour, by its place in the list. Goals have no stored colour at all. */
export function goalColors(goals: { id: string }[]): Map<string, string> {
    return new Map(goals.map((g, i) => [g.id, cardColor(i)]));
}
