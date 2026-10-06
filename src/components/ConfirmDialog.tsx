import { useEffect, useRef } from "react";

interface Props {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Replaces window.confirm. Focus starts on Cancel so Enter can't delete by accident. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: Props) {
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => cancelRef.current?.focus(), []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onCancel]);

    return (
        <div className="modal-backdrop" onMouseDown={onCancel}>
            <div
                className="modal confirm-modal"
                role="alertdialog"
                aria-modal="true"
                aria-label={title}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <h2 className="confirm-title">{title}</h2>
                <p className="confirm-message">{message}</p>
                <div className="modal-actions">
                    <button ref={cancelRef} type="button" className="btn btn-quiet" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="btn btn-danger" onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
