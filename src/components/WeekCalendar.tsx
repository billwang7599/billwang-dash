import { useEffect, useMemo, useRef, useState } from "react";
import {
    addDays,
    civilFromDate,
    civilFromKey,
    civilKey,
    diffDays,
    minutesOfDay,
    minutesToTime,
    nextWeekday,
    zonedToUtcMs,
    type Civil,
} from "../../shared/civil.ts";
import type { CalEvent, CalendarItem, EventInput } from "../../shared/types.ts";
import { api } from "../api.ts";
import { eventItem, tempId } from "../optimistic.ts";
import { useCalendarRange } from "../useCalendarRange.ts";
import {
    LONG_PRESS_MS,
    SNAP_MINUTES,
    dragRange,
    edgeScrollSpeed,
    minutesAtOffset,
    movedMinutes,
    rangeToEvent,
    resizedEndMinutes,
    resizedStartMinutes,
} from "../eventDrag.ts";
import { EventDetails } from "./EventDetails.tsx";
import { Hero } from "./Hero.tsx";
import { EventModal } from "./EventModal.tsx";
import { layoutEvents } from "../eventLayout.ts";
import { allDayDates, formatInstant } from "../format.ts";
import { NARROW, useMediaQuery } from "../useMediaQuery.ts";

const HOUR_PX = 46;

/** Which part of an event a shift+drag takes hold of. */
type Edge = "start" | "end" | "move";
type Mode = "day" | "3day" | "week";
const MODES: { mode: Mode; label: string; days: number; unit: string }[] = [
    { mode: "day", label: "Day", days: 1, unit: "day" },
    { mode: "3day", label: "3 days", days: 3, unit: "3 days" },
    { mode: "week", label: "Week", days: 7, unit: "week" },
];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A press on a day column, from pointer down to up. */
interface Drag {
    day: string;
    /** The column the press began in; the pointer's minutes are measured against it. */
    column: HTMLElement;
    anchor: number;
    moved: boolean;
    startX: number;
    startY: number;
    /** The pointer's latest position, which the edge auto-scroll keeps following. */
    x: number;
    y: number;
    /** Pressed on an event: nothing starts until the pointer moves, so a click still opens it. */
    onEvent: boolean;
    reshape?: { item: CalendarItem; edge: Edge };
    touch: boolean;
    /** Touch, until the long press completes: the timer that picks the press up. */
    holding?: number;
}

/** Where a search result wants the calendar: that day, with the event's editor open. */
export interface CalendarJump {
    day: string;
    event?: CalEvent;
}

interface Props {
    timeZone: string;
    /** Project id -> card colour; a task on the calendar is outlined in its project's. */
    colors: Map<string, string>;
    /** Bumped by the parent whenever tasks change, to force a refetch. */
    revision: number;
    /** A task on the calendar was clicked; the parent opens its editor. */
    onOpenTask: (taskId: string) => void;
    /** A search result asked to see this; each new object moves the calendar there. */
    jump?: CalendarJump | null;
}

/**
 * Week view merging scheduled tasks with Google Calendar events.
 *
 * Placement is done in the user's timezone rather than the browser's: a task
 * created as "5pm in Chicago" should sit at 5pm on the Chicago row even when
 * you open the app from another country.
 */
export function WeekCalendar({ timeZone, colors, revision, onOpenTask, jump }: Props) {
    // Until a view is picked, a phone shows one day and anything wider the week.
    // Not persisted: a session-only preference, like the sidebar's collapse.
    const narrow = useMediaQuery(NARROW);
    const [chosenMode, setMode] = useState<Mode | null>(null);
    const mode = chosenMode ?? (narrow ? "day" : "week");
    const { days: dayCount, unit } = MODES.find((m) => m.mode === mode)!;
    // The focused day, not the range, is the state: switching views or resizing
    // keeps you on the same day. The week snaps to Monday; day and 3-day start on it.
    const [focus, setFocus] = useState<Civil>(() => civilFromDate(new Date(), timeZone));
    useEffect(() => {
        const day = jump && civilFromKey(jump.day);
        if (day) setFocus(day);
        if (jump?.event) setEditor({ initial: toInput(jump.event), id: jump.event.id });
    }, [jump]);
    const rangeStart = useMemo(() => (mode === "week" ? startOfWeek(focus) : focus), [focus, mode]);
    const [selected, setSelected] = useState<CalendarItem | null>(null);
    const gridRef = useRef<HTMLDivElement>(null);

    // Press and drag on a day column draws a new event. Shift+drag on one of dash's own events
    // reshapes it: from its top edge it moves the start, from its bottom edge the end, and from
    // anywhere else it moves the whole event. On touch a long press stands in for both the press
    // and the shift, so a swipe still scrolls. `drag` holds the gesture; `draft` and `reshape`
    // are what is shown so far.
    const dragRef = useRef<Drag | null>(null);
    const lastPointer = useRef("");
    // A long press ends in a click the browser sends anyway; it must not open anything.
    const swallowClick = useRef(false);
    const [draft, setDraft] = useState<{ day: string; start: number; end: number } | null>(null);
    // `saving` keeps the new times on screen until the refetch brings them back from the server.
    const [reshape, setReshape] = useState<{ id: string; start: string; end: string; saving: boolean } | null>(null);
    const [shiftHeld, setShiftHeld] = useState(false);
    const [editor, setEditor] = useState<{ initial: EventInput; id: string | null } | null>(null);
    const [reload, setReload] = useState(0);
    // Cached ranges paint at once and revalidate behind; only a range never seen gets a spinner.
    const { items, syncing, error, setError, removeItem, putItem } = useCalendarRange(
        rangeStart,
        dayCount,
        timeZone,
        `${revision}:${reload}`,
    );
    const [refreshing, setRefreshing] = useState(false);

    /** Skips the cache: Google is asked again, then this range reloads. */
    async function refresh() {
        setRefreshing(true);
        setError(null);
        try {
            await api.syncGoogle();
            setReload((n) => n + 1);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setRefreshing(false);
        }
    }

    const days = useMemo(
        () => Array.from({ length: dayCount }, (_, i) => addDays(rangeStart, i)),
        [rangeStart, dayCount],
    );

    // Open on the working day rather than at midnight.
    useEffect(() => {
        if (gridRef.current) gridRef.current.scrollTop = 7 * HOUR_PX;
    }, []);

    const shown = useMemo(
        () =>
            reshape
                ? items.map((i) => (i.id === reshape.id ? { ...i, start: reshape.start, end: reshape.end } : i))
                : items,
        [items, reshape],
    );

    useEffect(() => {
        if (!reshape?.saving) return;
        const saved = items.find((i) => i.id === reshape.id);
        if (!saved || (Date.parse(saved.start) === Date.parse(reshape.start) && Date.parse(saved.end) === Date.parse(reshape.end))) {
            setReshape(null);
        }
    }, [items, reshape]);

    useEffect(() => {
        const track = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
        window.addEventListener("keydown", track);
        window.addEventListener("keyup", track);
        return () => {
            window.removeEventListener("keydown", track);
            window.removeEventListener("keyup", track);
        };
    }, []);

    const byDay = useMemo(() => {
        const map = new Map<string, { timed: CalendarItem[]; allDay: CalendarItem[] }>();
        for (const day of days) map.set(civilKey(day), { timed: [], allDay: [] });

        for (const item of shown) {
            // All-day events, dash's and Google's, are dates, not instants: each covers every
            // day from its first to its last, however many that is.
            const dates = !item.allDay
                ? null
                : item.event
                  ? { first: item.event.startDate, last: item.event.endDate }
                  : item.kind === "gcal"
                    ? allDayDates(item)
                    : null;
            if (dates) {
                for (const day of days) {
                    const key = civilKey(day);
                    if (key >= dates.first && key <= dates.last) map.get(key)?.allDay.push(item);
                }
            } else if (item.allDay) {
                map.get(civilKey(civilFromDate(new Date(item.start), timeZone)))?.allDay.push(item);
            } else {
                // A timed item sits in every day it overlaps, so one that runs past
                // midnight continues into the next column.
                const startMs = Date.parse(item.start);
                const endMs = Date.parse(item.end);
                for (const day of days) {
                    if (startMs < zonedToUtcMs(addDays(day, 1), 0, timeZone) && endMs > zonedToUtcMs(day, 0, timeZone)) {
                        map.get(civilKey(day))?.timed.push(item);
                    }
                }
            }
        }
        return map;
    }, [shown, days, timeZone]);

    const todayK = civilKey(civilFromDate(new Date(), timeZone));
    const nowMinutes = minutesOfDay(new Date(), timeZone);

    /** Tasks and dash events have editors; Google events get a read-only details view. */
    function open(item: CalendarItem) {
        if (item.kind === "task") onOpenTask(item.id.replace(/^task:/, ""));
        else if (item.kind === "event" && item.event) setEditor({ initial: toInput(item.event), id: item.event.id });
        else setSelected(item);
    }

    /** Minutes into the day for a pointer at `clientY`, against the column the press began in. */
    const minutesAt = (column: HTMLElement, clientY: number) =>
        minutesAtOffset(clientY - column.getBoundingClientRect().top, HOUR_PX);

    function onDayPointerDown(e: React.PointerEvent<HTMLDivElement>, day: string) {
        lastPointer.current = e.pointerType;
        swallowClick.current = false;
        const touch = e.pointerType === "touch";
        if (!touch && e.button !== 0) return;
        const column = e.currentTarget;
        const onEvent = (e.target as HTMLElement).closest<HTMLElement>(".cal-ev");
        // Shift, or a held finger, takes hold of one of dash's own events; the others only open.
        const grabs = onEvent !== null && (e.shiftKey || touch);
        const item = grabs
            ? items.find((i) => i.event && i.event.id === onEvent.dataset.eventId && !i.allDay)
            : undefined;
        if (grabs && !item) return;
        // The edge strips only exist where the event really starts or ends, so on a
        // continuation segment shift+drag moves the whole event.
        const edge = ((e.target as HTMLElement).closest<HTMLElement>(".cal-ev-edge")?.dataset.edge ?? "move") as Edge;
        const anchor = minutesAt(column, e.clientY);
        const drag: Drag = {
            day,
            column,
            anchor,
            moved: false,
            startX: e.clientX,
            startY: e.clientY,
            x: e.clientX,
            y: e.clientY,
            onEvent: onEvent !== null,
            reshape: item && { item, edge },
            touch,
        };
        dragRef.current = drag;
        followEdges(drag);
        if (touch) {
            // Until the finger has rested, the touch is the browser's to scroll or tap with.
            const pointerId = e.pointerId;
            drag.holding = window.setTimeout(() => pickUp(drag, pointerId), LONG_PRESS_MS);
            return;
        }
        if (onEvent) return;
        column.setPointerCapture(e.pointerId);
        setDraft({ day, ...dragRange(anchor, anchor, false) });
    }

    /** The long press completed: lift the event, or start drawing a new one from the pressed slot. */
    function pickUp(drag: Drag, pointerId: number) {
        if (dragRef.current !== drag) return;
        drag.holding = undefined;
        swallowClick.current = true;
        navigator.vibrate?.(10);
        // Keep the moves coming to this column after the finger leaves it, as the mouse does.
        if (drag.column.isConnected) drag.column.setPointerCapture(pointerId);
        if (drag.reshape) {
            const { item } = drag.reshape;
            setReshape({ id: item.id, start: item.start, end: item.end, saving: false });
        } else {
            setDraft({ day: drag.day, ...dragRange(drag.anchor, drag.anchor, false) });
        }
    }

    /**
     * While a drag lasts, holding the pointer near the grid's top or bottom scrolls it, and
     * the drag follows: a finger can't scroll mid-drag, and a mouse shouldn't have to let go.
     */
    function followEdges(drag: Drag) {
        const step = () => {
            if (dragRef.current !== drag) return;
            const grid = gridRef.current;
            if (grid && drag.moved) {
                const { top, bottom } = grid.getBoundingClientRect();
                const before = grid.scrollTop;
                grid.scrollTop += edgeScrollSpeed(drag.y, top, bottom);
                if (grid.scrollTop !== before) follow(drag, drag.x, drag.y);
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    /** The day column under `clientX`, the nearest one when it is outside the grid. */
    function dayUnder(clientX: number, fallback: string): string {
        const columns = [...(gridRef.current?.querySelectorAll<HTMLElement>(".cal-day") ?? [])];
        if (columns.length === 0) return fallback;
        const hit = columns.find((c) => {
            const r = c.getBoundingClientRect();
            return clientX >= r.left && clientX < r.right;
        });
        const nearest = clientX < columns[0].getBoundingClientRect().left ? columns[0] : columns[columns.length - 1];
        return (hit ?? nearest).dataset.day ?? fallback;
    }

    /**
     * `item` reshaped to the pointer, which is at `minutes` in column `day`; the drag began at
     * `anchor` in column `from`. Never shorter than one slot.
     */
    function reshaped(item: CalendarItem, edge: Edge, from: string, anchor: number, day: string, minutes: number) {
        const start = Date.parse(item.start);
        const end = Date.parse(item.end);
        const slot = SNAP_MINUTES * 60_000;
        const at = (m: number) => zonedToUtcMs(civilFromKey(day)!, m, timeZone);
        let next: { start: number; end: number };
        if (edge === "start") next = { start: Math.min(at(resizedStartMinutes(minutes)), end - slot), end };
        else if (edge === "end") next = { start, end: Math.max(at(resizedEndMinutes(minutes)), start + slot) };
        else {
            // Whole days by the calendar, so a move across a clock change keeps the local time;
            // the minutes the pointer travelled are added on top.
            const days = diffDays(civilFromKey(from)!, civilFromKey(day)!);
            const by = movedMinutes(anchor, minutes) * 60_000;
            const shift = (ms: number) => {
                const d = new Date(ms);
                return zonedToUtcMs(addDays(civilFromDate(d, timeZone), days), minutesOfDay(d, timeZone), timeZone) + by;
            };
            next = { start: shift(start), end: shift(end) };
        }
        return { start: new Date(next.start).toISOString(), end: new Date(next.end).toISOString() };
    }

    async function saveReshape(item: CalendarItem, start: string, end: string) {
        const event = item.event!;
        const startAt = new Date(start);
        const endAt = new Date(end);
        setReshape({ id: item.id, start, end, saving: true });
        try {
            await api.updateEvent(event.id, {
                ...toInput(event),
                startDate: civilKey(civilFromDate(startAt, timeZone)),
                startTime: minutesToTime(minutesOfDay(startAt, timeZone)),
                endDate: civilKey(civilFromDate(endAt, timeZone)),
                endTime: minutesToTime(minutesOfDay(endAt, timeZone)),
            });
            setReload((n) => n + 1);
        } catch (err) {
            setReshape(null);
            setError((err as Error).message);
        }
    }

    /** Shows the drag with the pointer at (`x`, `y`). */
    function follow(drag: Drag, x: number, y: number) {
        drag.x = x;
        drag.y = y;
        const minutes = minutesAt(drag.column, y);
        if (drag.reshape) {
            const { item, edge } = drag.reshape;
            setReshape({ id: item.id, ...reshaped(item, edge, drag.day, drag.anchor, dayUnder(x, drag.day), minutes), saving: false });
        } else {
            setDraft({ day: drag.day, ...dragRange(drag.anchor, minutes, true) });
        }
    }

    function onDayPointerMove(e: React.PointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag) return;
        const travel = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
        if (drag.holding !== undefined) {
            // Moving before the long press completes is a scroll, which the browser takes.
            if (travel > 8) cancelDrag();
            return;
        }
        // A few pixels of wobble is still a click.
        if (!drag.moved && travel < 4) return;
        if (!drag.moved && drag.onEvent && !drag.touch) e.currentTarget.setPointerCapture(e.pointerId);
        drag.moved = true;
        follow(drag, e.clientX, e.clientY);
    }

    function onDayPointerUp(e: React.PointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag) return; // cancelled with Escape
        dragRef.current = null;
        if (drag.holding !== undefined) {
            clearTimeout(drag.holding); // a tap: the click handles it
            return;
        }
        if (drag.onEvent && !drag.moved) {
            // A click opens the event itself; one lifted by a long press is put back down.
            setReshape((r) => (r?.saving ? r : null));
            return;
        }
        if (drag.reshape) {
            const { item, edge } = drag.reshape;
            const { start, end } = reshaped(item, edge, drag.day, drag.anchor, dayUnder(e.clientX, drag.day), minutesAt(drag.column, e.clientY));
            void saveReshape(item, start, end);
            return;
        }
        const { start, end } = dragRange(drag.anchor, minutesAt(drag.column, e.clientY), drag.moved);
        setDraft(null);
        setEditor({ initial: rangeToEvent(drag.day, start, end), id: null });
    }

    /**
     * A tap on an empty slot opens a new hour there. The browser only sends the click
     * when the touch didn't scroll, so this can't fire mid-swipe. Mouse clicks are
     * already handled by the press-and-drag above.
     */
    function onDayClick(e: React.MouseEvent<HTMLDivElement>, day: string) {
        if (lastPointer.current !== "touch" || (e.target as HTMLElement).closest(".cal-ev")) return;
        const { start, end } = dragRange(minutesAt(e.currentTarget, e.clientY), 0, false);
        setEditor({ initial: rangeToEvent(day, start, end), id: null });
    }

    function cancelDrag() {
        clearTimeout(dragRef.current?.holding);
        dragRef.current = null;
        setDraft(null);
        setReshape((r) => (r?.saving ? r : null));
    }

    // Once a long press has picked something up, the finger drags it instead of scrolling the
    // grid. React's touch listeners are passive, and only a non-passive one can stop the scroll.
    useEffect(() => {
        const grid = gridRef.current;
        if (!grid) return;
        const hold = (e: TouchEvent) => {
            const drag = dragRef.current;
            if (drag?.touch && drag.holding === undefined) e.preventDefault();
        };
        grid.addEventListener("touchmove", hold, { passive: false });
        return () => grid.removeEventListener("touchmove", hold);
    }, []);

    useEffect(() => {
        if (!draft && !reshape) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelDrag();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [draft, reshape]);

    /** The "New event" button: the next whole hour today, or 9am on the first day shown. */
    function newEventDefaults(): EventInput {
        const inWeek = days.some((d) => civilKey(d) === todayK);
        if (!inWeek) return rangeToEvent(civilKey(days[0]), 9 * 60, 10 * 60);
        const start = Math.min(23 * 60, (Math.floor(nowMinutes / 60) + 1) * 60);
        return rangeToEvent(todayK, start, start + 60);
    }

    const colorStyle = (item: CalendarItem) => {
        const c = item.kind === "task" ? item.projectId && colors.get(item.projectId) : item.color;
        return c ? { ["--c" as string]: c } : {};
    };
    const first = days[0];
    const last = days[days.length - 1];
    const rangeLabel =
        first.m === last.m
            ? `${first.d}${dayCount > 1 ? ` – ${last.d}` : ""} ${MONTHS[first.m - 1]}`
            : `${first.d} ${MONTHS[first.m - 1]} – ${last.d} ${MONTHS[last.m - 1]}`;
    const taskCount = items.filter((i) => i.kind === "task").length;

    /** Shown at once; the refetch after the save brings the server's copy, and a failure puts things back. */
    async function saveEvent(input: EventInput) {
        const id = editor?.id ?? tempId();
        const before = items.find((i) => i.id === `event:${id}`);
        putItem(eventItem(input, id, timeZone));
        (editor?.id ? api.updateEvent(id, input) : api.createEvent(input))
            .then(() => setReload((n) => n + 1))
            .catch((err: Error) => {
                if (before) putItem(before);
                else removeItem(`event:${id}`);
                setError(err.message);
            });
    }

    async function deleteEvent() {
        if (!editor?.id) return;
        const id = editor.id;
        const before = items.find((i) => i.id === `event:${id}`);
        removeItem(`event:${id}`);
        api.deleteEvent(id)
            .then(() => setReload((n) => n + 1))
            .catch((err: Error) => {
                if (before) putItem(before);
                setError(err.message);
            });
    }

    return (
        <div className={`cal-wrap${shiftHeld ? " is-shift" : ""}`} style={{ ["--days" as string]: dayCount }}>
            <header className="cal-head">
                <div className="cal-bar">
                    <div className="cal-modes" role="group" aria-label="Calendar view">
                        {MODES.map((m) => (
                            <button
                                key={m.mode}
                                className={m.mode === mode ? "is-active" : undefined}
                                aria-pressed={m.mode === mode}
                                onClick={() => setMode(m.mode)}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <div className="cal-nav">
                        <button onClick={() => setFocus(addDays(focus, -dayCount))} aria-label={`Previous ${unit}`}>
                            ←
                        </button>
                        <button
                            className="cal-today"
                            onClick={() => setFocus(civilFromDate(new Date(), timeZone))}
                        >
                            Today
                        </button>
                        <button onClick={() => setFocus(addDays(focus, dayCount))} aria-label={`Next ${unit}`}>
                            →
                        </button>
                    </div>
                    <div className="cal-actions">
                        <button
                            className={`cal-refresh${refreshing ? " is-spinning" : ""}`}
                            onClick={refresh}
                            disabled={refreshing}
                            aria-label="Sync with Google"
                            title="Sync with Google"
                        >
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                <path
                                    d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </button>
                        <button className="cal-new" onClick={() => setEditor({ initial: newEventDefaults(), id: null })}>
                            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                            New event
                        </button>
                    </div>
                </div>
                <Hero
                    kicker={syncing ? "Syncing…" : rangeLabel}
                    title={`${MONTHS[rangeStart.m - 1].toUpperCase()} ${rangeStart.y}`}
                    stats={[
                        { value: syncing ? "–" : items.length - taskCount, label: "events" },
                        { value: syncing ? "–" : taskCount, label: "tasks" },
                    ]}
                />
            </header>

            {error && <p className="cal-error">{error}</p>}

            <div className="cal-daybar">
                <span className="cal-gutter" />
                {days.map((day) => {
                    const key = civilKey(day);
                    return (
                        <div className={`cal-dayhead${key === todayK ? " is-today" : ""}`} key={key}>
                            <span className="dh-name">{DAY_LABELS[new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()]}</span>
                            <span className="dh-num">{day.d}</span>
                            <div className="dh-allday">
                                {byDay.get(key)?.allDay.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={`allday ${item.kind}`}
                                        style={colorStyle(item)}
                                        title={item.title}
                                        onClick={() => open(item)}
                                    >
                                        {item.title}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="cal-body">
                {syncing && (
                    <div className="cal-syncing" role="status">
                        <span className="spinner" aria-hidden="true" />
                        Syncing…
                    </div>
                )}
                <div
                    className="cal-grid"
                    ref={gridRef}
                    onClickCapture={(e) => {
                        if (!swallowClick.current) return;
                        swallowClick.current = false;
                        e.stopPropagation();
                    }}
                    // A long press is a drag here, not the browser's menu.
                    onContextMenu={(e) => lastPointer.current === "touch" && e.preventDefault()}
                >
                    <div className="cal-hours">
                        {Array.from({ length: 24 }, (_, h) => (
                            <div className="cal-hour" key={h} style={{ height: HOUR_PX }}>
                                <span>{h === 0 ? "" : `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`}</span>
                            </div>
                        ))}
                    </div>

                    {days.map((day) => {
                        const key = civilKey(day);
                        const dayStartMs = zonedToUtcMs(day, 0, timeZone);
                        const isToday = key === todayK;

                        return (
                            <div
                                className={`cal-day${isToday ? " is-today" : ""}`}
                                key={key}
                                data-day={key}
                                onPointerDown={(e) => onDayPointerDown(e, key)}
                                onPointerMove={onDayPointerMove}
                                onPointerUp={onDayPointerUp}
                                onPointerCancel={cancelDrag}
                                onClick={(e) => onDayClick(e, key)}
                            >
                                {Array.from({ length: 24 }, (_, h) => (
                                    <div className="cal-slot" key={h} style={{ height: HOUR_PX }} />
                                ))}

                                {isToday && (
                                    <div className="cal-now" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
                                        <span />
                                    </div>
                                )}

                                {layoutEvents(byDay.get(key)?.timed ?? []).map(({ item, column, columns, span }) => {
                                    // Clipped to this day, so an overnight item continues in the next column.
                                    const startMin = Math.max(0, (Date.parse(item.start) - dayStartMs) / 60_000);
                                    const endMin = Math.min(1440, (Date.parse(item.end) - dayStartMs) / 60_000);
                                    const height = Math.max(18, ((endMin - startMin) / 60) * HOUR_PX);
                                    // Let a long title wrap as far as the event is tall, instead of one clipped line.
                                    const showTime = height >= 50;
                                    const titleLines = Math.max(1, Math.floor((height - 10 - (showTime ? 13 : 0)) / 14));

                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            className={`cal-ev ${item.kind}${reshape?.id === item.id && !reshape.saving ? " is-lifted" : ""}`}
                                            data-p={item.priority}
                                            data-event-id={item.event?.id}
                                            style={{
                                                top: (startMin / 60) * HOUR_PX,
                                                height,
                                                left: `${(column / columns) * 100}%`,
                                                width: `${(span / columns) * 100}%`,
                                                ["--lines" as string]: titleLines,
                                                ...colorStyle(item),
                                            }}
                                            title={`${item.title} — ${formatInstant(item.start, timeZone)}`}
                                            onClick={() => open(item)}
                                        >
                                            {/* Where shift+drag changes the start or the end; see onDayPointerDown. */}
                                            {item.kind === "event" && item.event && !item.allDay && (
                                                <>
                                                    {Date.parse(item.start) >= dayStartMs && (
                                                        <span className="cal-ev-edge is-top" data-edge="start" />
                                                    )}
                                                    {Date.parse(item.end) <= zonedToUtcMs(addDays(day, 1), 0, timeZone) && (
                                                        <span className="cal-ev-edge is-bottom" data-edge="end" />
                                                    )}
                                                </>
                                            )}
                                            <span className="ev-title">{item.title}</span>
                                            {showTime && (
                                                <span className="ev-time">{formatInstant(item.start, timeZone)}</span>
                                            )}
                                        </button>
                                    );
                                })}

                                {draft && draft.day === key && (
                                    <div
                                        className="cal-ev event is-draft"
                                        style={{
                                            top: (draft.start / 60) * HOUR_PX,
                                            height: ((draft.end - draft.start) / 60) * HOUR_PX,
                                            left: 0,
                                            width: "100%",
                                        }}
                                    >
                                        <span className="ev-title">(No title)</span>
                                        <span className="ev-time">
                                            {minutesToTime(draft.start)}–{minutesToTime(draft.end)}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {editor && (
                <EventModal
                    initial={editor.initial}
                    isExisting={editor.id !== null}
                    onSave={saveEvent}
                    onDelete={deleteEvent}
                    onClose={() => setEditor(null)}
                />
            )}

            {selected && (
                <EventDetails item={selected} timeZone={timeZone} onClose={() => setSelected(null)} />
            )}
        </div>
    );
}

const toInput = (e: CalEvent): EventInput => ({
    title: e.title,
    description: e.description,
    startDate: e.startDate,
    startTime: e.startTime,
    endDate: e.endDate,
    endTime: e.endTime,
});

function startOfWeek(civil: Civil): Civil {
    // Weeks run Monday-first; nextWeekday looks forward, so step back a week.
    const monday = nextWeekday(civil, 1, true);
    return civilKey(monday) === civilKey(civil) ? civil : addDays(monday, -7);
}
