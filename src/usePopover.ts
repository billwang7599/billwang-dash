import { useEffect, useRef, useState } from "react";

/**
 * Open state for a button-and-popover pair. While open, a press outside `ref`
 * (put it on the element wrapping both) or Escape closes it.
 */
export function usePopover<T extends HTMLElement>() {
    const [open, setOpen] = useState(false);
    const ref = useRef<T>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        window.addEventListener("pointerdown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", onDown);
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return { open, setOpen, ref };
}
