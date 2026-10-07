import { useEffect, useMemo, useRef, useState } from "react";
import {
    addDays,
    civilFromDate,
    civilKey,
    minutesOfDay,
    minutesToTime,
    nextWeekday,
    zonedToUtcMs,
    type Civil,
} from "../../shared/civil.ts";
import type { CalEvent, CalendarItem, EventInput } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useCalendarRange } from "../useCalendarRange.ts";
import { dragRange, minutesAtOffset, rangeToEvent } from "../eventDrag.ts";
import { EventDetails } from "./EventDetails.tsx";
import { Hero } from "./Hero.tsx";
import { EventModal } from "./EventModal.tsx";
import { layoutEvents } from "../eventLayout.ts";
import { formatInstant } from "../format.ts";
import { NARROW, useMediaQuery } from "../useMediaQuery.ts";

const HOUR_PX = 46;
type Mode = "day" | "3day" | "week";
const MODES: { mode: Mode; label: string; days: number; unit: string }[] = [
    { mode: "day", label: "Day", days: 1, unit: "day" },
    { mode: "3day", label: "3 days", days: 3, unit: "3 days" },
    { mode: "week", label: "Week", days: 7, unit: "week" },
];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Props {
    timeZone: string;
    /** Project id -> card colour; a task on the calendar is outlined in its project's. */
    colors: Map<string, string>;
    /** Bumped by the parent whenever tasks change, to force a refetch. */
    revision: number;
    /** A task on the calendar was clicked; the parent opens its editor. */
    onOpenTask: (taskId: string) => void;
}

/**
 * Week view merging scheduled tasks with Google Calendar events.
 *
 * Placement is done in the user's timezone rather than the browser's: a task
 * created as "5pm in Chicago" should sit at 5pm on the Chicago row even when
 * you open the app from another country.
 */
export function WeekCalendar({ timeZone, colors, revision, onOpenTask }: Props) {
    // Until a view is picked, a phone shows one day and anything wider the week.
    // Not persisted: a session-only preference, like the sidebar's collapse.
    const narrow = useMediaQuery(NARROW);
    const [chosenMode, setMode] = useState<Mode | null>(null);
    const mode = chosenMode ?? (narrow ? "day" : "week");
    const { days: dayCount, unit } = MODES.find((m) => m.mode === mode)!;
    // The focused day, not the range, is the state: switching views or resizing
    // keeps you on the same day. The week snaps to Monday; day and 3-day start on it.
    const [focus, setFocus] = useState<Civil>(() => civilFromDate(new Date(), timeZone));
    const rangeStart = useMemo(() => (mode === "week" ? startOfWeek(focus) : focus), [focus, mode]);
    const [selected, setSelected] = useState<CalendarItem | null>(null);
    const gridRef = useRef<HTMLDivElement>(null);

    // Press and drag on a day column draws a new event. `drag` holds the gesture; `draft`
    // is what is drawn so far.
    const dragRef = useRef<{ day: string; anchor: number; moved: boolean; startY: number } | null>(null);
    const lastPointer = useRef("");
    const [draft, setDraft] = useState<{ day: string; start: number; end: number } | null>(null);
    const [editor, setEditor] = useState<{ initial: EventInput; id: string | null } | null>(null);
    const [reload, setReload] = useState(0);
    // Cached ranges paint at once and revalidate behind; only a range never seen gets a spinner.
    const { items, syncing, error, setError, removeItem } = useCalendarRange(
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

    const byDay = useMemo(() => {
        const map = new Map<string, { timed: CalendarItem[]; allDay: CalendarItem[] }>();
        for (const day of days) map.set(civilKey(day), { timed: [], allDay: [] });

        for (const item of items) {
            if (item.allDay && item.event) {
                // A dash all-day event is dates, not instants: it covers every day from
                // its first to its last, however many that is.
                for (const day of days) {
                    const key = civilKey(day);
                    if (key >= item.event.startDate && key <= item.event.endDate) map.get(key)?.allDay.push(item);
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
    }, [items, days, timeZone]);

    const todayK = civilKey(civilFromDate(new Date(), timeZone));
    const nowMinutes = minutesOfDay(new Date(), timeZone);

    /** Tasks and dash events have editors; Google events get a read-only details view. */
    function open(item: CalendarItem) {
        if (item.kind === "task") onOpenTask(item.id.replace(/^task:/, ""));
        else if (item.kind === "event" && item.event) setEditor({ initial: toInput(item.event), id: item.event.id });
        else setSelected(item);
    }

    /** Minutes into the day for the pointer, relative to the column it started in. */
    const minutesAt = (e: React.MouseEvent<HTMLDivElement>) =>
        minutesAtOffset(e.clientY - e.currentTarget.getBoundingClientRect().top, HOUR_PX);

    function onDayPointerDown(e: React.PointerEvent<HTMLDivElement>, day: string) {
        lastPointer.current = e.pointerType;
        // Touch scrolls the grid, so it can't also draw; tapping a slot works there instead.
        if (e.pointerType === "touch" || e.button !== 0) return;
        if ((e.target as HTMLElement).closest(".cal-ev")) return;
        const anchor = minutesAt(e);
        dragRef.current = { day, anchor, moved: false, startY: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDraft({ day, ...dragRange(anchor, anchor, false) });
    }

    function onDayPointerMove(e: React.PointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag) return;
        // A few pixels of wobble is still a click.
        if (!drag.moved && Math.abs(e.clientY - drag.startY) < 4) return;
        drag.moved = true;
        setDraft({ day: drag.day, ...dragRange(drag.anchor, minutesAt(e), true) });
    }

    function onDayPointerUp(e: React.PointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag) return; // cancelled with Escape
        dragRef.current = null;
        const { start, end } = dragRange(drag.anchor, minutesAt(e), drag.moved);
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
        const { start, end } = dragRange(minutesAt(e), 0, false);
        setEditor({ initial: rangeToEvent(day, start, end), id: null });
    }

    function cancelDrag() {
        dragRef.current = null;
        setDraft(null);
    }

    useEffect(() => {
        if (!draft) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelDrag();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [draft]);

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

    async function saveEvent(input: EventInput) {
        if (editor?.id) await api.updateEvent(editor.id, input);
        else await api.createEvent(input);
        setReload((n) => n + 1);
    }

    async function deleteEvent() {
        if (!editor?.id) return;
        removeItem(`event:${editor.id}`);
        await api.deleteEvent(editor.id);
        setReload((n) => n + 1);
    }

    return (
        <div className="cal-wrap" style={{ ["--days" as string]: dayCount }}>
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
                <div className="cal-grid" ref={gridRef}>
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
                                            className={`cal-ev ${item.kind}`}
                                            data-p={item.priority}
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
