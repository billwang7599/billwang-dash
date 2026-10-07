import { useEffect, type ReactNode } from "react";

interface Props {
    /** The dialog's accessible name. */
    label: string;
    /** Extra class on the .modal box, for per-modal sizing. */
    className?: string;
    role?: "dialog" | "alertdialog";
    /** Backdrop and Escape call this. Omit for a modal that can't be dismissed (first-run setup). */
    onClose?: () => void;
    /** False while a dialog stacked on top of this one owns Escape. */
    closeOnEscape?: boolean;
    /** From useDismiss: plays the exit animation. */
    closing?: boolean;
    children: ReactNode;
}

/**
 * The backdrop and box every modal shares. Pair with useDismiss so Cancel and
 * Save leave through the same exit animation as the backdrop and Escape.
 */
export function Modal({ label, className, role = "dialog", onClose, closeOnEscape = true, closing = false, children }: Props) {
    useEffect(() => {
        if (!onClose || !closeOnEscape) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose, closeOnEscape]);

    return (
        <div className={`modal-backdrop${closing ? " is-closing" : ""}`} onMouseDown={onClose}>
            <div
                className={`modal${className ? ` ${className}` : ""}`}
                role={role}
                aria-modal="true"
                aria-label={label}
                // A press inside the box mustn't reach the backdrop and close it.
                onMouseDown={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );
}
