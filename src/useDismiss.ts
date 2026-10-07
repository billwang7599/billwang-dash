import { useCallback, useRef, useState } from "react";

/** Matches the modal-sink animation in app.css. */
const EXIT_MS = 140;

/**
 * Lets a modal play its exit animation before the parent unmounts it. Route
 * every way out (backdrop, Escape, Cancel, after a save) through `dismiss`
 * and put `is-closing` on the backdrop while `closing` is true.
 */
export function useDismiss(onClose: () => void): [closing: boolean, dismiss: () => void] {
    const [closing, setClosing] = useState(false);
    const started = useRef(false);
    const dismiss = useCallback(() => {
        if (started.current) return;
        started.current = true;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose();
        setClosing(true);
        setTimeout(onClose, EXIT_MS);
    }, [onClose]);
    return [closing, dismiss];
}
