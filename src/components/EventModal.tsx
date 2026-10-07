import { useEffect, useRef, useState } from "react";
import { eventProblem } from "../../shared/events.ts";
import type { EventInput } from "../../shared/types.ts";
import { useDismiss } from "../useDismiss.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Modal } from "./Modal.tsx";

interface Props {
    /** The event being edited, or a new one pre-filled from a drag or the New event button. */
    initial: EventInput;
    /** Present when editing an existing event. */
    isExisting: boolean;
    onSave: (input: EventInput) => Promise<void>;
    onDelete: () => Promise<void>;
    onClose: () => void;
}

/** Create or edit a dash calendar event. The rules come from shared/events.ts, the server's too. */
export function EventModal({ initial, isExisting, onSave, onDelete, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [title, setTitle] = useState(initial.title);
    const [allDay, setAllDay] = useState(initial.startTime === null);
    const [startDate, setStartDate] = useState(initial.startDate);
    const [startTime, setStartTime] = useState(initial.startTime ?? "09:00");
    const [endDate, setEndDate] = useState(initial.endDate);
    const [endTime, setEndTime] = useState(initial.endTime ?? "10:00");
    const [description, setDescription] = useState(initial.description);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const titleRef = useRef<HTMLInputElement>(null);

    useEffect(() => titleRef.current?.focus(), []);

    const input: EventInput = {
        title: title.trim(),
        description,
        startDate,
        startTime: allDay ? null : startTime,
        endDate,
        endTime: allDay ? null : endTime,
    };
    const problem = eventProblem(input);
    // An empty title just leaves Save disabled; it isn't worth a scolding.
    const shownProblem = title.trim() === "" ? null : problem;

    async function run(action: () => Promise<void>) {
        setBusy(true);
        setError(null);
        try {
            await action();
            close();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    function save(event: React.FormEvent) {
        event.preventDefault();
        if (!problem) void run(() => onSave(input));
    }

    /** Moving the start past the end drags the end date along, like Google Calendar. */
    function changeStartDate(value: string) {
        setStartDate(value);
        if (endDate < value) setEndDate(value);
    }

    return (
        <>
            <Modal
                label={isExisting ? "Edit event" : "New event"}
                className="event-edit"
                closing={closing}
                onClose={close}
                // The delete confirmation on top owns Escape while it is open.
                closeOnEscape={!confirmingDelete}
            >
                <form onSubmit={save}>
                    <input
                        ref={titleRef}
                        className="modal-title"
                        value={title}
                        maxLength={200}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Add a title"
                        aria-label="Event title"
                    />

                    <label className="event-allday">
                        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
                        All day
                    </label>

                    <div className="event-fields">
                        <label>
                            <span>Starts</span>
                            <input type="date" value={startDate} onChange={(e) => changeStartDate(e.target.value)} />
                        </label>
                        {!allDay && (
                            <label>
                                <span>Time</span>
                                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                            </label>
                        )}
                        <label>
                            <span>Ends</span>
                            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
                        </label>
                        {!allDay && (
                            <label>
                                <span>Time</span>
                                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                            </label>
                        )}
                    </div>

                    <textarea
                        className="modal-desc"
                        value={description}
                        maxLength={5000}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Description"
                        aria-label="Description"
                        rows={3}
                    />

                    {shownProblem && <p className="modal-error">{shownProblem}</p>}
                    {error && <p className="modal-error">{error}</p>}

                    <div className="modal-actions">
                        {isExisting && (
                            <button
                                type="button"
                                className="btn btn-quiet btn-quiet-danger event-delete"
                                onClick={() => setConfirmingDelete(true)}
                                disabled={busy}
                            >
                                Delete
                            </button>
                        )}
                        <button type="button" className="btn btn-quiet" onClick={close}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={problem !== null || busy}>
                            {busy ? "Saving…" : "Save"}
                        </button>
                    </div>
                </form>
            </Modal>

            {/* A sibling, not a child: a click on its backdrop must not bubble up and close this editor too. */}
            {confirmingDelete && (
                <ConfirmDialog
                    title="Delete event?"
                    message={`"${initial.title}" will be permanently deleted, and removed from Google Calendar if syncing is on.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        setConfirmingDelete(false);
                        void run(onDelete);
                    }}
                    onCancel={() => setConfirmingDelete(false)}
                />
            )}
        </>
    );
}
