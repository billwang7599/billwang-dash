import { useSyncExternalStore } from "react";

/** The phone layout: top bar and drawer, single-day calendar. Mirrors the CSS breakpoint. */
export const NARROW = "(max-width: 780px)";

/** Whether a media query matches, re-rendering when that changes (rotation, resizing). */
export function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (onChange) => {
            const list = window.matchMedia(query);
            list.addEventListener("change", onChange);
            return () => list.removeEventListener("change", onChange);
        },
        () => window.matchMedia(query).matches,
    );
}
