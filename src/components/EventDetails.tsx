import { useEffect, useRef } from "react";
import type { CalendarItem } from "../../shared/types.ts";
import { formatEventWhen } from "../format.ts";
import { htmlToText } from "../htmlToText.ts";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";

interface Props {
    item: CalendarItem;
    timeZone: string;
    onClose: () => void;
}

/** Read-only details for a Google Calendar event. Tasks open the task editor instead. */
export function EventDetails({ item, timeZone, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const closeRef = useRef<HTMLButtonElement>(null);
    const description = item.description ? htmlToText(item.description) : "";

    useEffect(() => closeRef.current?.focus(), []);

    return (
        <Modal label={item.title} className="event-modal" closing={closing} onClose={close}>
            <h2 className="event-title">{item.title}</h2>

            <dl className="event-facts">
                <dt>When</dt>
                <dd>{formatEventWhen(item, timeZone)}</dd>
                {item.calendarName && (
                    <>
                        <dt>Calendar</dt>
                        <dd>{item.calendarName}</dd>
                    </>
                )}
                {item.location && (
                    <>
                        <dt>Where</dt>
                        <dd>{item.location}</dd>
                    </>
                )}
            </dl>

            {description && <p className="event-desc">{description}</p>}

            <div className="modal-actions">
                {item.htmlLink && (
                    <a className="btn btn-quiet" href={item.htmlLink} target="_blank" rel="noopener noreferrer">
                        Open in Google Calendar ↗
                    </a>
                )}
                <button ref={closeRef} type="button" className="btn btn-primary" onClick={close}>
                    Close
                </button>
            </div>
        </Modal>
    );
}
