import { useEffect, useState } from "react";
import type { View } from "../App.tsx";

interface Props {
    view: View;
    firstName: string;
    todayCount: number;
    overdueCount: number;
    navigate: (path: string) => void;
}

/** One entry per feature; on a phone the menu doesn't list each project, goal or habit. */
const ITEMS: { label: string; path: string; active: (v: View) => boolean }[] = [
    { label: "Inbox", path: "/app", active: (v) => v.name === "inbox" || v.name === "completed" },
    { label: "Calendar", path: "/app/calendar", active: (v) => v.name === "calendar" },
    { label: "Projects", path: "/app/projects", active: (v) => v.name === "projects" || v.name === "project" },
    { label: "Goals", path: "/app/goals", active: (v) => v.name === "goals" },
    { label: "Habits", path: "/app/habits", active: (v) => v.name === "habits" || v.name === "habit" },
    { label: "Settings", path: "/app/settings", active: (v) => v.name === "settings" || v.name === "trash" },
];

type MenuState = "closed" | "open" | "closing";

/**
 * Phone navigation: a round button bottom-right that opens a speed-dial of
 * pills. Pills rise in one after another (nearest the button first); closing
 * plays a quick fade before the menu unmounts.
 */
export function MobileNav({ view, firstName, todayCount, overdueCount, navigate }: Props) {
    const [menu, setMenu] = useState<MenuState>("closed");
    const shown = menu !== "closed";

    const close = () => setMenu((m) => (m === "open" ? "closing" : m));
    const toggle = () => setMenu((m) => (m === "open" ? "closing" : "open"));

    useEffect(() => {
        if (menu !== "open") return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [menu]);

    const go = (path: string) => {
        navigate(path);
        close();
    };

    return (
        <div className={`mnav${shown ? " is-open" : ""}${menu === "closing" ? " is-closing" : ""}`}>
            {shown && (
                <>
                    <div className="mnav-backdrop" onClick={close} aria-hidden="true" />
                    <nav
                        className="mnav-pills"
                        aria-label="Menu"
                        // The backdrop's fade-out is the last thing to finish.
                        onAnimationEnd={(e) => {
                            if (menu === "closing" && e.target === e.currentTarget) setMenu("closed");
                        }}
                    >
                        {/* Laid out bottom-up (column-reverse): Inbox sits nearest the button,
                            and --i, the stagger step, is just the position from the bottom. */}
                        {ITEMS.map((item, i) => {
                            const count = item.path === "/app" ? todayCount : 0;
                            return (
                                <button
                                    key={item.path}
                                    className={`mnav-pill${item.active(view) ? " is-active" : ""}`}
                                    style={{ "--i": i } as React.CSSProperties}
                                    onClick={() => go(item.path)}
                                    aria-current={item.active(view) ? "page" : undefined}
                                >
                                    {item.label}
                                    {count > 0 && (
                                        <span className={`nav-count${overdueCount > 0 ? " is-urgent" : ""}`}>{count}</span>
                                    )}
                                </button>
                            );
                        })}
                        <p className="mnav-hello" style={{ "--i": ITEMS.length } as React.CSSProperties}>
                            {firstName ? `Hello, ${firstName}!` : "Hello!"}
                        </p>
                    </nav>
                </>
            )}

            <button
                className="mnav-fab"
                onClick={toggle}
                aria-label={menu === "open" ? "Close menu" : "Open menu"}
                aria-expanded={menu === "open"}
            >
                <span className="mnav-bar" />
                <span className="mnav-bar" />
                <span className="mnav-bar" />
            </button>
        </div>
    );
}
