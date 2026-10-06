import { useEffect, useMemo, useRef, useState } from "react";
import { timeZoneList } from "../format.ts";

interface Props {
    value: string;
    /** Pinned to the top and tagged "this device". */
    deviceZone: string;
    labelledBy: string;
    onChange: (timeZone: string) => void;
}

/** "America/New_York" matches "new york", "america" and "york". */
const normalise = (s: string) => s.toLowerCase().replace(/[_/]/g, " ");

/** A searchable dropdown over the IANA zone list. */
export function TimeZoneSelect({ value, deviceZone, labelledBy, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const listRef = useRef<HTMLUListElement>(null);

    const zones = useMemo(() => timeZoneList([value, deviceZone]), [value, deviceZone]);

    const matches = useMemo(() => {
        const q = normalise(query.trim());
        const found = q ? zones.filter((z) => normalise(z).includes(q)) : zones;
        return found.includes(deviceZone)
            ? [deviceZone, ...found.filter((z) => z !== deviceZone)]
            : found;
    }, [zones, query, deviceZone]);

    useEffect(() => {
        listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
    }, [active, open]);

    function openList() {
        setQuery("");
        setActive(0);
        setOpen(true);
    }

    function choose(tz: string) {
        setOpen(false);
        if (tz !== value) onChange(tz);
    }

    function onKeyDown(e: React.KeyboardEvent) {
        if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, matches.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter" && open) {
            e.preventDefault();
            if (matches[active]) choose(matches[active]);
        } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
        }
    }

    return (
        <div className="tz-select">
            <input
                role="combobox"
                aria-expanded={open}
                aria-controls="tz-listbox"
                aria-labelledby={labelledBy}
                aria-activedescendant={open && matches[active] ? `tz-opt-${active}` : undefined}
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
                value={open ? query : value}
                placeholder={value}
                onFocus={openList}
                onClick={() => !open && openList()}
                onBlur={() => setOpen(false)}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                    setOpen(true);
                }}
                onKeyDown={onKeyDown}
            />
            {open && (
                <ul id="tz-listbox" className="tz-list" role="listbox" ref={listRef}>
                    {matches.length === 0 && <li className="tz-none">No matching time zone</li>}
                    {matches.map((tz, i) => (
                        <li
                            key={tz}
                            id={`tz-opt-${i}`}
                            role="option"
                            aria-selected={tz === value}
                            className={`tz-option${i === active ? " is-active" : ""}${tz === value ? " is-current" : ""}`}
                            // mousedown, not click: the input's blur would close the list first.
                            onMouseDown={(e) => {
                                e.preventDefault();
                                choose(tz);
                            }}
                            onMouseEnter={() => setActive(i)}
                        >
                            <span>{tz.replace(/_/g, " ")}</span>
                            {tz === deviceZone && <span className="tz-tag">this device</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
