import { useEffect, useRef } from "react";
import type { CalendarItem } from "../../shared/types.ts";
import { formatEventWhen } from "../format.ts";
import { htmlToText } from "../htmlToText.ts";

interface Props {
    item: CalendarItem;
    timeZone: string;
    onClose: () => void;
}

/** Read-only details for a Google Calendar event. Tasks open the task editor instead. */
export function EventDetails({ item, timeZone, onClose }: Props) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const description = item.description ? htmlToText(item.description) : "";

    useEffect(() => closeRef.current?.focus(), []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className="modal-backdrop" onMouseDown={onClose}>
            <div
                className="modal event-modal"
                role="dialog"
                aria-modal="true"
                aria-label={item.title}
                onMouseDown={(e) => e.stopPropagation()}
            >
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
                    <button ref={closeRef} type="button" className="btn btn-primary" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
