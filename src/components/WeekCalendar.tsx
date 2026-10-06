import { useEffect, useMemo, useRef, useState } from "react";
import {
    addDays,
    civilFromDate,
    civilKey,
    minutesOfDay,
    nextWeekday,
    zonedToUtcMs,
    type Civil,
} from "../../shared/civil.ts";
import type { CalendarItem } from "../../shared/types.ts";
import { api } from "../api.ts";
import { EventDetails } from "./EventDetails.tsx";
import { layoutEvents } from "../eventLayout.ts";
import { formatInstant } from "../format.ts";

const HOUR_PX = 46;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Props {
    timeZone: string;
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
export function WeekCalendar({ timeZone, revision, onOpenTask }: Props) {
    const [weekStart, setWeekStart] = useState<Civil>(() =>
        startOfWeek(civilFromDate(new Date(), timeZone)),
    );
    const [items, setItems] = useState<CalendarItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<CalendarItem | null>(null);
    const gridRef = useRef<HTMLDivElement>(null);

    const days = useMemo(
        () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
        [weekStart],
    );

    useEffect(() => {
        let cancelled = false;
        const start = new Date(zonedToUtcMs(weekStart, 0, timeZone)).toISOString();
        const end = new Date(zonedToUtcMs(addDays(weekStart, 7), 0, timeZone)).toISOString();

        setLoading(true);
        api
            .calendar(start, end)
            .then((res) => {
                if (!cancelled) {
                    setItems(res.items);
                    setError(null);
                }
            })
            .catch((err: Error) => !cancelled && setError(err.message))
            .finally(() => !cancelled && setLoading(false));

        return () => {
            cancelled = true;
        };
    }, [weekStart, timeZone, revision]);

    // Open on the working day rather than at midnight.
    useEffect(() => {
        if (gridRef.current) gridRef.current.scrollTop = 7 * HOUR_PX;
    }, []);

    const byDay = useMemo(() => {
        const map = new Map<string, { timed: CalendarItem[]; allDay: CalendarItem[] }>();
        for (const day of days) map.set(civilKey(day), { timed: [], allDay: [] });

        for (const item of items) {
            const key = civilKey(civilFromDate(new Date(item.start), timeZone));
            const bucket = map.get(key);
            if (!bucket) continue;
            (item.allDay ? bucket.allDay : bucket.timed).push(item);
        }
        return map;
    }, [items, days, timeZone]);

    const todayK = civilKey(civilFromDate(new Date(), timeZone));
    const nowMinutes = minutesOfDay(new Date(), timeZone);

    /** Tasks have their own editor; Google events get a read-only details view. */
    function open(item: CalendarItem) {
        if (item.kind === "task") onOpenTask(item.id.replace(/^task:/, ""));
        else setSelected(item);
    }

    return (
        <div className="cal-wrap">
            <header className="cal-head">
                <div className="cal-title">
                    <h2>
                        {MONTHS[weekStart.m - 1]} {weekStart.y}
                    </h2>
                    {loading && <span className="cal-loading">syncing…</span>}
                </div>
                <div className="cal-nav">
                    <button onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
                        ←
                    </button>
                    <button
                        className="cal-today"
                        onClick={() => setWeekStart(startOfWeek(civilFromDate(new Date(), timeZone)))}
                    >
                        Today
                    </button>
                    <button onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
                        →
                    </button>
                </div>
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
                        <div className={`cal-day${isToday ? " is-today" : ""}`} key={key}>
                            {Array.from({ length: 24 }, (_, h) => (
                                <div className="cal-slot" key={h} style={{ height: HOUR_PX }} />
                            ))}

                            {isToday && (
                                <div className="cal-now" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
                                    <span />
                                </div>
                            )}

                            {layoutEvents(byDay.get(key)?.timed ?? []).map(({ item, column, columns, span }) => {
                                const startMin = (Date.parse(item.start) - dayStartMs) / 60_000;
                                const endMin = (Date.parse(item.end) - dayStartMs) / 60_000;
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
                        </div>
                    );
                })}
            </div>

            {selected && (
                <EventDetails item={selected} timeZone={timeZone} onClose={() => setSelected(null)} />
            )}
        </div>
    );
}

function startOfWeek(civil: Civil): Civil {
    // Weeks run Monday-first; nextWeekday looks forward, so step back a week.
    const monday = nextWeekday(civil, 1, true);
    return civilKey(monday) === civilKey(civil) ? civil : addDays(monday, -7);
}
