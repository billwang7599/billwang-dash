import { useState } from "react";
import type { Preferences } from "../api.ts";
import { canonicalTimeZone, deviceTimeZone } from "../format.ts";

const DISMISSED_KEY = "dash.tzDismissed";

/** Per-browser convenience only; the page works without storage. */
function readDismissed(): string | null {
    try {
        return localStorage.getItem(DISMISSED_KEY);
    } catch {
        return null;
    }
}

interface Props {
    preferences: Preferences;
    onSwitch: (timeZone: string) => void;
}

/**
 * Task times float with the zone in Settings, so a device that has moved to
 * another zone is worth a heads-up. "Keep" silences it for that device zone only.
 */
export function TimeZoneNotice({ preferences, onSwitch }: Props) {
    const device = deviceTimeZone();
    const [dismissed, setDismissed] = useState(readDismissed);

    if (!preferences.timeZoneSet) return null; // still being auto-detected
    if (canonicalTimeZone(device) === canonicalTimeZone(preferences.timeZone)) return null;
    if (dismissed === device) return null;

    function keep() {
        try {
            localStorage.setItem(DISMISSED_KEY, device);
        } catch {
            /* dismissal just lasts until reload */
        }
        setDismissed(device);
    }

    return (
        <div className="banner banner-info tz-notice" role="status">
            <span>
                Your device is in <strong>{device}</strong>, but dash is set to{" "}
                <strong>{preferences.timeZone}</strong>. Task times follow the setting.
            </span>
            <span className="tz-notice-actions">
                <button className="btn btn-primary" onClick={() => onSwitch(device)}>
                    Switch to {device}
                </button>
                <button className="btn btn-quiet" onClick={keep}>
                    Keep {preferences.timeZone}
                </button>
            </span>
        </div>
    );
}
