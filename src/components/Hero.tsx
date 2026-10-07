import type { ReactNode } from "react";
import { PROJECT_COLORS, type ProjectColor } from "../../shared/types.ts";
import { colorValue } from "../projectColors.ts";
import { usePopover } from "../usePopover.ts";

export interface HeroStat {
    value: string | number;
    label: string;
    /** Makes the stat a link-like button. */
    onClick?: () => void;
}

interface Props {
    /** The small line above the big title. */
    kicker: string;
    title: ReactNode;
    /** Colours a full stop after the title (a project's colour). */
    accent?: string;
    /** When given, the full stop is a button that opens a swatch picker. */
    onPickAccent?: (color: ProjectColor) => void;
    stats?: HeroStat[];
}

/** The page's one big number or name, with a few counts on the right. */
export function Hero({ kicker, title, accent, onPickAccent, stats = [] }: Props) {
    return (
        <header className="hero">
            <div className="hero-main">
                <p className="hero-kicker">{kicker}</p>
                <h1 className="hero-title">
                    {title}
                    {accent &&
                        (onPickAccent ? (
                            <AccentPicker accent={accent} onPick={onPickAccent} />
                        ) : (
                            <span className="hero-dot" style={{ color: accent }} aria-hidden="true">
                                .
                            </span>
                        ))}
                </h1>
            </div>
            {stats.length > 0 && (
                <div className="hero-stats">
                    {stats.map((s) => {
                        const body = (
                            <>
                                {/* Keyed on the value so a change remounts it and replays the roll-up. */}
                                <span key={s.value} className="hero-stat-value">{s.value}</span>
                                <span className="hero-stat-label">{s.label}</span>
                            </>
                        );
                        return s.onClick ? (
                            <button key={s.label} className="hero-stat is-link" onClick={s.onClick}>
                                {body}
                            </button>
                        ) : (
                            <div key={s.label} className="hero-stat">
                                {body}
                            </div>
                        );
                    })}
                </div>
            )}
        </header>
    );
}

/** The coloured full stop as a button, with the preset colours in a popover under it. */
function AccentPicker({ accent, onPick }: { accent: string; onPick: (color: ProjectColor) => void }) {
    const { open, setOpen, ref } = usePopover<HTMLSpanElement>();

    return (
        <span className="hero-picker" ref={ref}>
            <button
                className="hero-dot is-button"
                style={{ color: accent }}
                onClick={() => setOpen(!open)}
                aria-label="Change colour"
                aria-expanded={open}
                title="Change colour"
            >
                .
            </button>
            {open && (
                <span className="swatches" role="group" aria-label="Colours">
                    {PROJECT_COLORS.map((c) => (
                        <button
                            key={c}
                            className={`swatch-btn${colorValue(c) === accent ? " is-on" : ""}`}
                            style={{ background: colorValue(c) }}
                            aria-label={c}
                            aria-pressed={colorValue(c) === accent}
                            onClick={() => {
                                onPick(c);
                                setOpen(false);
                            }}
                        />
                    ))}
                </span>
            )}
        </span>
    );
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "2026-10-06" -> { weekday: "Tuesday", title: "06 OCT" }. */
export function heroDate(dateKey: string): { weekday: string; title: string } {
    const [y, m, d] = dateKey.split("-").map(Number);
    return {
        weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
        title: `${String(d).padStart(2, "0")} ${MONTHS[m - 1]}`,
    };
}
