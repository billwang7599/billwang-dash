import { useEffect, useState, type ReactNode } from "react";
import type { GoogleAccountStatus } from "../../shared/types.ts";
import { api, type Preferences } from "../api.ts";
import { deviceTimeZone } from "../format.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { TimeZoneSelect } from "./TimeZoneSelect.tsx";

interface Props {
    preferences: Preferences;
    user: { email: string; name: string | null; isAdmin: boolean };
    onPreferencesChange: (prefs: Preferences) => void;
    onOpenTrash: () => void;
}

export function Settings({ preferences, user, onPreferencesChange, onOpenTrash }: Props) {
    const [google, setGoogle] = useState<GoogleAccountStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
    const [confirmingPushOff, setConfirmingPushOff] = useState(false);
    const [pushBusy, setPushBusy] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [cliTokenExists, setCliTokenExists] = useState(false);
    const [newCliToken, setNewCliToken] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirmingCli, setConfirmingCli] = useState<"regenerate" | "revoke" | null>(null);
    const [firstName, setFirstName] = useState(preferences.firstName);
    const [lastName, setLastName] = useState(preferences.lastName);
    const nameChanged =
        firstName.trim() !== preferences.firstName || lastName.trim() !== preferences.lastName;
    const nameValid = firstName.trim() !== "" && lastName.trim() !== "";

    useEffect(() => {
        api.googleStatus().then(setGoogle).catch((e: Error) => setError(e.message));
        api.cliTokenStatus().then((s) => setCliTokenExists(s.exists)).catch((e: Error) => setError(e.message));

        // The OAuth callback bounces back here with the outcome in the query string.
        const result = new URLSearchParams(window.location.search).get("google");
        if (result === "connected") setNotice("Google Calendar connected.");
        else if (result) setError(decodeURIComponent(result));
        if (result) {
            window.history.replaceState({}, "", "/app/settings");
        }
    }, []);

    async function toggleCalendar(id: string, enabled: boolean) {
        setGoogle(await api.setCalendarEnabled(id, enabled));
    }

    async function syncNow() {
        setSyncing(true);
        setError(null);
        try {
            setGoogle(await api.syncGoogle());
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSyncing(false);
        }
    }

    async function disconnect() {
        setGoogle(await api.disconnectGoogle());
        setNotice("Google Calendar disconnected.");
    }

    async function setPush(enabled: boolean) {
        setError(null);
        setPushBusy(true);
        try {
            setGoogle(await api.setGooglePush(enabled));
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setPushBusy(false);
        }
    }

    // While tasks are still being pushed, check back until the queue drains.
    useEffect(() => {
        if (!google?.push.enabled || google.push.pending === 0) return;
        const timer = setTimeout(() => {
            api.googleStatus().then(setGoogle).catch(() => {});
        }, 3000);
        return () => clearTimeout(timer);
    }, [google]);

    async function createCliToken() {
        setError(null);
        try {
            setNewCliToken((await api.createCliToken()).token);
            setCliTokenExists(true);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    async function revokeCliToken() {
        setError(null);
        try {
            await api.revokeCliToken();
            setNewCliToken(null);
            setCliTokenExists(false);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    async function copyCliToken() {
        if (!newCliToken) return;
        try {
            await navigator.clipboard.writeText(newCliToken);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError("Couldn't copy. Select the token and copy it by hand.");
        }
    }

    async function updatePrefs(patch: Partial<Preferences>) {
        setError(null);
        try {
            const { preferences: next } = await api.setPreferences(patch);
            onPreferencesChange(next);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    return (
        <div className="settings">
            <p className="hero-kicker">Settings</p>
            <a className="settings-wordmark" href="/">
                dash<span className="dot">.</span>
            </a>

            {notice && <p className="banner banner-ok">{notice}</p>}
            {error && <p className="banner banner-bad">{error}</p>}

            <section className="panel">
                <h2>Account</h2>
                <form
                    className="set-row"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (nameChanged && nameValid) {
                            void updatePrefs({ firstName: firstName.trim(), lastName: lastName.trim() });
                        }
                    }}
                >
                    <div className="set-row-text">
                        <span className="set-row-label">Name</span>
                    </div>
                    <div className="set-row-control set-name">
                        <input
                            value={firstName}
                            maxLength={50}
                            autoComplete="given-name"
                            aria-label="First name"
                            placeholder="First"
                            onChange={(e) => setFirstName(e.target.value)}
                        />
                        <input
                            value={lastName}
                            maxLength={50}
                            autoComplete="family-name"
                            aria-label="Last name"
                            placeholder="Last"
                            onChange={(e) => setLastName(e.target.value)}
                        />
                        <button type="submit" className="btn btn-quiet" disabled={!nameChanged || !nameValid}>
                            Save
                        </button>
                    </div>
                </form>
                <Row label="Signed in as" hint={`Cloudflare Access${user.isAdmin ? " · admin" : ""}`}>
                    <span className="set-value">{user.name ? `${user.name} · ${user.email}` : user.email}</span>
                </Row>
                <Row label="Sign out" hint="Ends your session on this device.">
                    {/* A plain link, not fetch(): signing out is a full navigation to Cloudflare
                        Access, and the in-memory app state must not survive it. */}
                    <a className="btn btn-quiet" href="/logout">
                        Sign out
                    </a>
                </Row>
            </section>

            <section className="panel">
                <h2>Preferences</h2>
                <Row label="Timezone" labelId="tz-label" hint="Task times follow this zone.">
                    <TimeZoneSelect
                        value={preferences.timeZone}
                        deviceZone={deviceTimeZone()}
                        labelledBy="tz-label"
                        onChange={(timeZone) => updatePrefs({ timeZone })}
                    />
                </Row>
                <Row label="Date order" labelId="date-order-label" hint="Only for slash dates like “3/5”.">
                    <select
                        aria-labelledby="date-order-label"
                        value={preferences.dateFormat}
                        onChange={(e) => updatePrefs({ dateFormat: e.target.value as "MDY" | "DMY" })}
                    >
                        <option value="MDY">Month first — 3/5 is 5 March</option>
                        <option value="DMY">Day first — 3/5 is 3 May</option>
                    </select>
                </Row>
            </section>

            <section className="panel">
                <h2>Google Calendar</h2>
                <p className="panel-note">Your Google events show beside your tasks in the calendar.</p>

                {google?.connected ? (
                    <>
                        <Row
                            label={google.email ?? "Connected"}
                            hint={
                                syncing
                                    ? "Syncing…"
                                    : google.lastSyncedAt
                                      ? `Last synced ${new Date(google.lastSyncedAt).toLocaleString()}`
                                      : "Not synced yet"
                            }
                        >
                            <button
                                className="btn btn-quiet"
                                onClick={syncNow}
                                disabled={syncing}
                                title="Events refresh on their own: today hourly, later days every 6 hours, past days only when you sync."
                            >
                                {syncing ? "Syncing…" : "Sync now"}
                            </button>
                            <button className="btn btn-quiet" onClick={() => setConfirmingDisconnect(true)}>
                                Disconnect
                            </button>
                        </Row>
                        {google.syncError && (
                            <p className="banner banner-bad" role="alert">
                                {google.syncError} <a href="/api/google/connect">Reconnect</a>
                            </p>
                        )}

                        {google.canWrite ? (
                            <Row
                                check
                                label="Show my tasks and events in Google"
                                hint={
                                    google.push.enabled
                                        ? google.push.pending > 0
                                            ? `Syncing, ${google.push.pending} waiting…`
                                            : "Up to date in your “dash” calendar."
                                        : "Adds a “dash” calendar. Your other calendars are never changed."
                                }
                            >
                                <input
                                    type="checkbox"
                                    checked={google.push.enabled}
                                    disabled={pushBusy}
                                    onChange={(e) => (e.target.checked ? setPush(true) : setConfirmingPushOff(true))}
                                />
                            </Row>
                        ) : (
                            <Row
                                label="Show my tasks and events in Google"
                                hint="dash needs permission to create its own calendar."
                            >
                                <a className="btn btn-quiet" href="/api/google/connect">
                                    Grant access
                                </a>
                            </Row>
                        )}
                        {google.push.error && <p className="banner banner-bad">{google.push.error}</p>}

                        {google.calendars.map((cal) => (
                            <Row
                                key={cal.id}
                                check
                                label={
                                    <>
                                        <span className="swatch" style={{ background: cal.color }} aria-hidden="true" />
                                        {cal.summary}
                                        {cal.primary && <span className="tag">primary</span>}
                                    </>
                                }
                            >
                                <input
                                    type="checkbox"
                                    checked={cal.enabled}
                                    onChange={(e) => toggleCalendar(cal.id, e.target.checked)}
                                />
                            </Row>
                        ))}
                    </>
                ) : (
                    <Row label="Not connected">
                        <a className="btn btn-primary" href="/api/google/connect">
                            Connect
                        </a>
                    </Row>
                )}
            </section>

            <section className="panel">
                <h2>Command line</h2>
                <p className="panel-note">
                    Lets the <code>dash</code> CLI, and AI agents that use it, change your data. Treat it like a password.
                </p>
                <Row label="Personal token" hint={cliTokenExists ? "A token is active." : "No token yet."}>
                    {cliTokenExists ? (
                        <>
                            <button type="button" className="btn btn-quiet" onClick={() => setConfirmingCli("regenerate")}>
                                Regenerate
                            </button>
                            <button
                                type="button"
                                className="btn btn-quiet btn-quiet-danger"
                                onClick={() => setConfirmingCli("revoke")}
                            >
                                Revoke
                            </button>
                        </>
                    ) : (
                        <button type="button" className="btn btn-quiet" onClick={createCliToken}>
                            Create token
                        </button>
                    )}
                </Row>
                {newCliToken && (
                    <div className="set-reveal">
                        <div className="share-link">
                            <input
                                readOnly
                                value={newCliToken}
                                aria-label="CLI token"
                                onFocus={(e) => e.currentTarget.select()}
                            />
                            <button type="button" className="btn btn-primary" onClick={copyCliToken}>
                                {copied ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <p className="set-row-hint">
                            Shown only this once. On your computer run <code>dash login &lt;token&gt;</code>.
                        </p>
                    </div>
                )}
            </section>

            <section className="panel">
                <h2>Recently deleted</h2>
                <Row label="Deleted projects and tasks" hint="Restore them, or delete them for good.">
                    <button className="btn btn-quiet" onClick={onOpenTrash}>
                        Open ›
                    </button>
                </Row>
            </section>

            {confirmingCli && (
                <ConfirmDialog
                    title={confirmingCli === "revoke" ? "Revoke the CLI token?" : "Make a new CLI token?"}
                    message="The current token stops working at once."
                    confirmLabel={confirmingCli === "revoke" ? "Revoke" : "Regenerate"}
                    onConfirm={() => {
                        setConfirmingCli(null);
                        void (confirmingCli === "revoke" ? revokeCliToken() : createCliToken());
                    }}
                    onCancel={() => setConfirmingCli(null)}
                />
            )}

            {confirmingPushOff && (
                <ConfirmDialog
                    title="Stop showing tasks and events in Google?"
                    message="This deletes the dash calendar from your Google account. Your tasks are not affected, and you can turn it back on."
                    confirmLabel="Turn off"
                    onConfirm={() => {
                        setConfirmingPushOff(false);
                        void setPush(false);
                    }}
                    onCancel={() => setConfirmingPushOff(false)}
                />
            )}

            {confirmingDisconnect && (
                <ConfirmDialog
                    title="Disconnect Google Calendar?"
                    message={
                        google?.push.enabled
                            ? "This also deletes the dash calendar from Google. Your tasks are not affected."
                            : "Your tasks are not affected. You can connect again at any time."
                    }
                    confirmLabel="Disconnect"
                    onConfirm={() => {
                        setConfirmingDisconnect(false);
                        void disconnect();
                    }}
                    onCancel={() => setConfirmingDisconnect(false)}
                />
            )}
        </div>
    );
}

interface RowProps {
    label: ReactNode;
    hint?: string;
    labelId?: string;
    check?: boolean;
    children: ReactNode;
}

function Row({ label, hint, labelId, check, children }: RowProps) {
    const Tag = check ? "label" : "div";
    return (
        <Tag className={check ? "set-row is-check" : "set-row"}>
            <div className="set-row-text">
                <span className="set-row-label" id={labelId}>
                    {label}
                </span>
                {hint && <small className="set-row-hint">{hint}</small>}
            </div>
            <div className="set-row-control">{children}</div>
        </Tag>
    );
}
