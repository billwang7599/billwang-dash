import { useEffect, useState } from "react";
import type { GoogleAccountStatus } from "../../shared/types.ts";
import { api, type Preferences } from "../api.ts";

interface Props {
  preferences: Preferences;
  user: { email: string; name: string | null; isAdmin: boolean };
  onPreferencesChange: (prefs: Preferences) => void;
}

export function Settings({ preferences, user, onPreferencesChange }: Props) {
  const [google, setGoogle] = useState<GoogleAccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.googleStatus().then(setGoogle).catch((e: Error) => setError(e.message));

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

  async function disconnect() {
    if (!confirm("Disconnect Google Calendar? Your tasks are not affected.")) return;
    setGoogle(await api.disconnectGoogle());
    setNotice("Google Calendar disconnected.");
  }

  async function updatePrefs(patch: Partial<Preferences>) {
    const { preferences: next } = await api.setPreferences(patch);
    onPreferencesChange(next);
  }

  return (
    <div className="settings">
      {notice && <p className="banner banner-ok">{notice}</p>}
      {error && <p className="banner banner-bad">{error}</p>}

      <section className="panel">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Signed in as</dt>
          <dd>{user.name ? `${user.name} · ${user.email}` : user.email}</dd>
          <dt>Identity</dt>
          <dd>Cloudflare Access{user.isAdmin ? " · admin" : ""}</dd>
        </dl>
      </section>

      <section className="panel">
        <h2>Google Calendar</h2>
        <p className="panel-note">
          Read-only. Your events appear beside scheduled tasks in the calendar
          view; dash never writes to your calendar.
        </p>

        {google?.connected ? (
          <>
            <div className="connected">
              <span className="dot-ok" aria-hidden="true" />
              <div>
                <strong>{google.email ?? "Connected"}</strong>
                <span className="connected-sub">
                  {google.lastSyncedAt
                    ? `last synced ${new Date(google.lastSyncedAt).toLocaleString()}`
                    : "not synced yet"}
                </span>
              </div>
              <button className="btn btn-quiet" onClick={disconnect}>
                Disconnect
              </button>
            </div>

            <ul className="callist">
              {google.calendars.map((cal) => (
                <li key={cal.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={cal.enabled}
                      onChange={(e) => toggleCalendar(cal.id, e.target.checked)}
                    />
                    <span className="swatch" style={{ background: cal.color }} aria-hidden="true" />
                    <span className="cal-name">{cal.summary}</span>
                    {cal.primary && <span className="tag">primary</span>}
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <a className="btn btn-primary" href="/api/google/connect">
            Connect Google Calendar
          </a>
        )}
      </section>

      <section className="panel">
        <h2>Dates &amp; times</h2>

        <label className="field">
          <span>Timezone</span>
          <input
            value={preferences.timeZone}
            onChange={(e) => onPreferencesChange({ ...preferences, timeZone: e.target.value })}
            onBlur={(e) => updatePrefs({ timeZone: e.target.value })}
            list="tz-list"
            spellCheck={false}
          />
          <datalist id="tz-list">
            {(Intl.supportedValuesOf?.("timeZone") ?? []).map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <small>New tasks are scheduled against this zone.</small>
        </label>

        <label className="field">
          <span>Numeric date order</span>
          <select
            value={preferences.dateFormat}
            onChange={(e) => updatePrefs({ dateFormat: e.target.value as "MDY" | "DMY" })}
          >
            <option value="MDY">Month first — 3/5 is 5 March</option>
            <option value="DMY">Day first — 3/5 is 3 May</option>
          </select>
          <small>Only affects slash-separated dates like “3/5”.</small>
        </label>
      </section>
    </div>
  );
}
