import { useEffect, useRef } from "react";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";

interface Props {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Replaces window.confirm. Focus starts on Cancel so Enter can't delete by accident. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: Props) {
    const [closing, cancel] = useDismiss(onCancel);
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => cancelRef.current?.focus(), []);

    return (
        <Modal label={title} className="confirm-modal" role="alertdialog" closing={closing} onClose={cancel}>
            <h2 className="confirm-title">{title}</h2>
            <p className="confirm-message">{message}</p>
            <div className="modal-actions">
                <button ref={cancelRef} type="button" className="btn btn-quiet" onClick={cancel}>
                    Cancel
                </button>
                <button type="button" className="btn btn-danger" onClick={onConfirm}>
                    {confirmLabel}
                </button>
            </div>
        </Modal>
    );
}
