import {
    GoogleApiError,
    WRITE_SCOPE,
    createCalendar,
    deleteCalendar,
    deleteEvent,
    insertEvent,
    listCalendars,
    listEvents,
    refreshAccessToken,
    updateEvent,
    type GoogleTokens,
} from "../google.ts";
import {
    backoffMs,
    classifyError,
    eventForCalEvent,
    eventForTask,
    eventIdForTask,
    fingerprint,
} from "../google-sync.ts";
import type {
    CalendarItem,
    GoogleAccountStatus,
    GoogleCalendarSummary,
    Preferences,
} from "../../shared/types.ts";
import { addDays, civilFromDate, civilFromKey, civilKey, weekday, zonedToUtcMs } from "../../shared/civil.ts";
import * as cache from "./gcal-cache.ts";
import * as eventStore from "./events.ts";
import * as taskStore from "./tasks.ts";

/** Edits within this window share one push run. */
const PUSH_DELAY_MS = 1500;
/** Tasks pushed per alarm run, to stay inside Google's rate limits. */
const PUSH_BATCH = 25;

/** Whether Google granted write access to dash's own calendar. */
const hasWriteScope = (scope: string | null | undefined): boolean =>
    (scope ?? "").split(" ").includes(WRITE_SCOPE);

/**
 * Everything between one user's data and Google: the connected account and its
 * calendars (read live into the calendar view), and pushing tasks and dash events
 * to a dash-owned calendar. It is a class because the in-flight token refresh is
 * state. UserDO owns one, delegates its RPC methods here, and keeps the `alarm()`
 * entry point the platform calls.
 */
export class GoogleSync {
    constructor(
        private readonly storage: DurableObjectStorage,
        private readonly env: Env,
        private readonly getPreferences: () => Promise<Preferences>,
    ) {}

    private get sql() {
        return this.storage.sql;
    }

    /** Single-use CSRF token, stored so the callback can consume it exactly once. */
    async beginAuth(): Promise<string> {
        const state = crypto.randomUUID();
        const cutoff = Date.now() - 10 * 60_000;
        this.sql.exec("DELETE FROM oauth_state WHERE created_at < ?", cutoff);
        this.sql.exec(
            "INSERT INTO oauth_state (state, created_at) VALUES (?, ?)",
            state, Date.now(),
        );
        return state;
    }

    async consumeAuthState(state: string): Promise<boolean> {
        const rows = this.sql
            .exec<{ state: string }>("SELECT state FROM oauth_state WHERE state = ?", state)
            .toArray();
        if (rows.length === 0) return false;
        this.sql.exec("DELETE FROM oauth_state WHERE state = ?", state);
        return true;
    }

    async connect(tokens: GoogleTokens): Promise<GoogleAccountStatus> {
        if (!tokens.refreshToken) {
            throw new Error(
                "Google did not return a refresh token. Revoke the app at " +
                    "myaccount.google.com/permissions and connect again.",
            );
        }

        // Reconnecting (say, to grant write access) must not forget the dash
        // calendar. A different Google account starts clean.
        const [prev] = this.sql
            .exec<{ email: string | null; dash_calendar_id: string | null; push_enabled: number }>(
                "SELECT email, dash_calendar_id, push_enabled FROM google_account WHERE id = 1",
            )
            .toArray();
        const sameAccount = prev !== undefined && prev.email === tokens.email;
        const canWrite = hasWriteScope(tokens.scope);
        if (prev && !sameAccount) this.clearPushState();

        this.sql.exec("DELETE FROM google_account");
        this.sql.exec(
            `INSERT INTO google_account
               (id, email, refresh_token, access_token, expires_at, connected_at,
                scope, dash_calendar_id, push_enabled)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            tokens.email, tokens.refreshToken, tokens.accessToken, tokens.expiresAt,
            new Date().toISOString(),
            tokens.scope,
            sameAccount ? prev.dash_calendar_id : null,
            sameAccount && canWrite ? prev.push_enabled : 0,
        );

        await this.refreshCalendarList(tokens.accessToken);
        return this.status();
    }

    async disconnect(): Promise<void> {
        await this.removeDashCalendar();
        this.sql.exec("DELETE FROM google_account");
        this.sql.exec("DELETE FROM google_calendars");
        cache.clear(this.sql);
    }

    async status(): Promise<GoogleAccountStatus> {
        const rows = this.sql
            .exec<{
                email: string | null;
                connected_at: string;
                last_synced_at: string | null;
                scope: string | null;
                push_enabled: number;
                push_error: string | null;
            }>(
                `SELECT email, connected_at, last_synced_at, scope, push_enabled, push_error
                 FROM google_account WHERE id = 1`,
            )
            .toArray();

        if (rows.length === 0) {
            return {
                connected: false,
                canWrite: false,
                push: { enabled: false, pending: 0, error: null },
                email: null,
                connectedAt: null,
                lastSyncedAt: null,
                calendars: [],
            };
        }

        return {
            connected: true,
            canWrite: hasWriteScope(rows[0].scope),
            push: {
                enabled: rows[0].push_enabled === 1,
                pending: this.sql
                    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM google_outbox")
                    .one().n,
                error: rows[0].push_error,
            },
            email: rows[0].email,
            connectedAt: rows[0].connected_at,
            lastSyncedAt: rows[0].last_synced_at,
            calendars: this.storedCalendars(),
        };
    }

    async setCalendarEnabled(calendarId: string, enabled: boolean): Promise<void> {
        this.sql.exec(
            "UPDATE google_calendars SET enabled = ? WHERE id = ?",
            enabled ? 1 : 0, calendarId,
        );
    }

    /**
     * Adds the user's Google events to the dash items for a window, soonest first.
     * Events come from the per-day cache (gcal-cache.ts); only days that are missing
     * or stale are fetched from Google, a run of consecutive days per request. If
     * Google can't be reached, whatever is cached is shown.
     */
    async calendarItems(items: CalendarItem[], startISO: string, endISO: string): Promise<CalendarItem[]> {
        const bySoonest = (list: CalendarItem[]) => list.sort((a, b) => a.start.localeCompare(b.start));

        const enabled = this.storedCalendars().filter((c) => c.enabled);
        if (enabled.length === 0 || !this.isConnected()) return bySoonest(items);

        const { timeZone } = await this.getPreferences();
        const now = Date.now();
        const today = civilFromDate(new Date(now), timeZone);
        const days = daysIn(startISO, endISO, timeZone);
        const dayStart = (key: string) => new Date(zonedToUtcMs(civilFromKey(key)!, 0, timeZone)).toISOString();
        const dayEnd = (key: string) =>
            new Date(zonedToUtcMs(addDays(civilFromKey(key)!, 1), 0, timeZone)).toISOString();

        const stale = new Map(enabled.map((cal) => [cal.id, cache.staleDays(this.sql, cal.id, days, civilKey(today), now)]));
        if ([...stale.values()].some((d) => d.length > 0)) {
            const accessToken = await this.getValidAccessToken();
            if (accessToken) {
                // One bad calendar shouldn't blank the whole view: it keeps its cache.
                await Promise.allSettled(
                    enabled.flatMap((cal) =>
                        cache.runs(stale.get(cal.id)!).map(async ([first, last]) => {
                            const from = dayStart(first);
                            const to = dayEnd(last);
                            const events = await listEvents(accessToken, cal.id, from, to);
                            cache.replaceDays(this.sql, cal.id, first, last, from, to, events, now);
                        }),
                    ),
                );
                this.sql.exec(
                    "UPDATE google_account SET last_synced_at = ? WHERE id = 1",
                    new Date(now).toISOString(),
                );
                cache.prune(this.sql, today, days[0]);
            }
        }

        if (days.length > 0) {
            const first = days[0];
            const last = days[days.length - 1];
            for (const cal of enabled) {
                for (const event of cache.readDays(this.sql, cal.id, first, last, dayStart(first), dayEnd(last))) {
                    items.push({
                        id: `gcal:${cal.id}:${event.id}`,
                        kind: "gcal",
                        title: event.summary,
                        start: event.start,
                        end: event.end,
                        allDay: event.allDay,
                        calendarId: cal.id,
                        color: cal.color,
                        htmlLink: event.htmlLink,
                        location: event.location,
                        description: event.description,
                        calendarName: cal.summary,
                    });
                }
            }
        }

        return bySoonest(items);
    }

    /**
     * A manual sync: every cached day goes stale (past days included), then this
     * week is fetched straight away so "last synced" moves. Other weeks refetch
     * when they're next looked at.
     */
    async syncNow(): Promise<GoogleAccountStatus> {
        cache.forgetSync(this.sql);
        const { timeZone } = await this.getPreferences();
        const today = civilFromDate(new Date(), timeZone);
        const monday = addDays(today, -((weekday(today) + 6) % 7));
        await this.calendarItems(
            [],
            new Date(zonedToUtcMs(monday, 0, timeZone)).toISOString(),
            new Date(zonedToUtcMs(addDays(monday, 7), 0, timeZone)).toISOString(),
        );
        return this.status();
    }

    private isConnected(): boolean {
        return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM google_account").one().n > 0;
    }

    private storedCalendars(): GoogleCalendarSummary[] {
        return this.sql
            .exec<{
                id: string; summary: string; color: string;
                is_primary: number; enabled: number;
            }>("SELECT * FROM google_calendars ORDER BY is_primary DESC, summary")
            .toArray()
            .map((c) => ({
                id: c.id,
                summary: c.summary,
                color: c.color,
                primary: c.is_primary === 1,
                enabled: c.enabled === 1,
            }));
    }

    private async refreshCalendarList(accessToken: string): Promise<void> {
        const dashId = this.pushState().calendarId;
        const calendars = (await listCalendars(accessToken)).filter((c) => c.id !== dashId);
        // Preserve which calendars the user switched off across a re-sync.
        const disabled = new Set(
            this.storedCalendars().filter((c) => !c.enabled).map((c) => c.id),
        );

        this.sql.exec("DELETE FROM google_calendars");
        for (const cal of calendars) {
            this.sql.exec(
                `INSERT INTO google_calendars (id, summary, color, is_primary, enabled)
               VALUES (?, ?, ?, ?, ?)`,
                cal.id, cal.summary, cal.color,
                cal.primary ? 1 : 0,
                disabled.has(cal.id) ? 0 : 1,
            );
        }
    }

    /** Shared in-flight refresh: a fetch lets requests interleave, so a burst
     * of calendar loads on an expired token would otherwise each refresh. */
    private refreshing: Promise<string | null> | null = null;

    private async getValidAccessToken(): Promise<string | null> {
        const rows = this.sql
            .exec<{ refresh_token: string; access_token: string | null; expires_at: number }>(
                "SELECT refresh_token, access_token, expires_at FROM google_account WHERE id = 1",
            )
            .toArray();
        if (rows.length === 0) return null;

        const row = rows[0];
        if (row.access_token && row.expires_at > Date.now() + 60_000) {
            return row.access_token;
        }

        this.refreshing ??= this.doRefresh(row.refresh_token).finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    private async doRefresh(refreshToken: string): Promise<string | null> {
        try {
            const tokens = await refreshAccessToken(this.env, refreshToken);
            this.sql.exec(
                "UPDATE google_account SET access_token = ?, expires_at = ? WHERE id = 1",
                tokens.accessToken, tokens.expiresAt,
            );
            return tokens.accessToken;
        } catch (err) {
            // A revoked grant should read as "not connected", not 500 the calendar.
            console.error("Google token refresh failed", err);
            return null;
        }
    }

    // ---- Google push (tasks -> a dash-owned calendar in Google) -------------

    private pushState(): { enabled: boolean; calendarId: string | null } {
        const [row] = this.sql
            .exec<{ push_enabled: number; dash_calendar_id: string | null }>(
                "SELECT push_enabled, dash_calendar_id FROM google_account WHERE id = 1",
            )
            .toArray();
        return { enabled: row?.push_enabled === 1, calendarId: row?.dash_calendar_id ?? null };
    }

    /** Turns syncing on (creating the dash calendar the first time) or off. */
    async setPush(enabled: boolean): Promise<GoogleAccountStatus> {
        if (!enabled) {
            await this.removeDashCalendar();
            return this.status();
        }

        const status = await this.status();
        if (!status.connected || !status.canWrite) {
            throw new Error("Google is not connected with write access");
        }

        const token = await this.getValidAccessToken();
        if (!token) throw new Error("Google needs to be reconnected");

        let calendarId = this.pushState().calendarId;
        if (!calendarId) {
            const { timeZone } = await this.getPreferences();
            calendarId = await createCalendar(token, "dash", timeZone);
        }
        this.sql.exec(
            "UPDATE google_account SET push_enabled = 1, push_error = NULL, dash_calendar_id = ? WHERE id = 1",
            calendarId,
        );
        await this.queueAll();
        return this.status();
    }

    /** Task times float with the zone, so Google's copies have to move too. */
    async timeZoneChanged(): Promise<void> {
        if (this.pushState().enabled) await this.queueAll();
    }

    /** Queue tasks for the next run. A no-op unless push is on. */
    async markDirty(taskIds: string[]): Promise<void> {
        if (taskIds.length === 0 || !this.pushState().enabled) return;
        const now = Date.now();
        for (const id of taskIds) {
            this.sql.exec(
                `INSERT INTO google_outbox (task_id, attempts, next_try_at, rev)
                 VALUES (?, 0, ?, 1)
                 ON CONFLICT(task_id) DO UPDATE
                   SET attempts = 0, next_try_at = excluded.next_try_at, rev = rev + 1`,
                id, now,
            );
        }
        await this.scheduleAlarm(now + PUSH_DELAY_MS);
    }

    /** Every task that has, or should have, a Google event. */
    async queueAll(): Promise<void> {
        const now = Date.now();
        // "WHERE true" stops SQLite reading ON CONFLICT as a join constraint.
        this.sql.exec(
            `INSERT INTO google_outbox (task_id, attempts, next_try_at, rev)
             SELECT id, 0, ?, 1 FROM tasks
              WHERE deleted_at IS NULL AND completed = 0 AND due_date IS NOT NULL
             UNION
             SELECT id, 0, ?, 1 FROM events
             UNION
             SELECT task_id, 0, ?, 1 FROM google_task_events WHERE true
             ON CONFLICT(task_id) DO UPDATE
               SET attempts = 0, next_try_at = excluded.next_try_at, rev = rev + 1`,
            now, now, now,
        );
        await this.scheduleAlarm(now + PUSH_DELAY_MS);
    }

    private async scheduleAlarm(at: number): Promise<void> {
        const current = await this.storage.getAlarm();
        if (current === null || at < current) await this.storage.setAlarm(at);
    }

    /** Pushes one batch of queued tasks to Google, then re-arms itself if more remain. */
    async runPush(): Promise<void> {
        const { enabled, calendarId } = this.pushState();
        if (!enabled || !calendarId) {
            this.sql.exec("DELETE FROM google_outbox");
            return;
        }

        const now = Date.now();
        const batch = this.sql
            .exec<{ task_id: string; attempts: number; rev: number }>(
                `SELECT task_id, attempts, rev FROM google_outbox
                 WHERE next_try_at <= ? ORDER BY next_try_at LIMIT ?`,
                now, PUSH_BATCH,
            )
            .toArray();

        if (batch.length > 0) {
            const token = await this.getValidAccessToken();
            if (!token) {
                this.stopPush("Google needs to be reconnected. Reconnect, then turn syncing on again.");
                return;
            }
            const { timeZone } = await this.getPreferences();

            for (const row of batch) {
                try {
                    await this.reconcileItem(token, calendarId, row.task_id, timeZone);
                    // Only if nothing edited the task while we were talking to Google.
                    this.sql.exec(
                        "DELETE FROM google_outbox WHERE task_id = ? AND rev = ?",
                        row.task_id, row.rev,
                    );
                } catch (err) {
                    const kind = classifyError(err);
                    if (kind === "reauth") {
                        this.stopPush("Google denied access. Reconnect Google, then turn syncing on again.");
                        return;
                    }
                    if (kind === "gone") {
                        this.stopPush(
                            "The dash calendar was deleted in Google. Turn syncing on again to recreate it.",
                            { calendarGone: true },
                        );
                        return;
                    }
                    if (kind === "fatal") {
                        // One task Google won't take must not stall the rest.
                        console.error("Google push gave up on a task", row.task_id, err);
                        this.sql.exec(
                            "DELETE FROM google_outbox WHERE task_id = ? AND rev = ?",
                            row.task_id, row.rev,
                        );
                        continue;
                    }
                    console.warn("Google push will retry", row.task_id, err);
                    this.sql.exec(
                        `UPDATE google_outbox SET attempts = attempts + 1, next_try_at = ?
                         WHERE task_id = ? AND rev = ?`,
                        Date.now() + backoffMs(row.attempts), row.task_id, row.rev,
                    );
                    if (err instanceof GoogleApiError && err.status === 429) break;
                }
            }
        }

        const [next] = this.sql
            .exec<{ at: number | null }>("SELECT MIN(next_try_at) AS at FROM google_outbox")
            .toArray();
        if (next?.at != null) await this.scheduleAlarm(Math.max(next.at, Date.now() + 1000));
    }

    /**
     * Makes Google's copy of one task or dash event match what it should be now.
     * Idempotent. Task and event ids are both UUIDs, so one id space (and one outbox)
     * serves both; an id that is neither means it was deleted.
     */
    private async reconcileItem(
        token: string,
        calendarId: string,
        taskId: string,
        timeZone: string,
    ): Promise<void> {
        const task = taskStore.getTaskForSync(this.sql, taskId);
        const event = task ? null : eventStore.getEvent(this.sql, taskId);
        const desired = task
            ? eventForTask(task, timeZone, this.env.APP_ORIGIN)
            : event
              ? eventForCalEvent(event, timeZone, this.env.APP_ORIGIN)
              : null;
        const [mapped] = this.sql
            .exec<{ fingerprint: string }>(
                "SELECT fingerprint FROM google_task_events WHERE task_id = ?",
                taskId,
            )
            .toArray();
        const eventId = eventIdForTask(taskId);

        if (!desired) {
            if (!mapped) return;
            try {
                await deleteEvent(token, calendarId, eventId);
            } catch (err) {
                if (classifyError(err) !== "gone") throw err;
            }
            this.sql.exec("DELETE FROM google_task_events WHERE task_id = ?", taskId);
            return;
        }

        const fp = await fingerprint(desired);
        if (mapped?.fingerprint === fp) return;

        if (mapped) {
            try {
                await updateEvent(token, calendarId, eventId, desired);
            } catch (err) {
                if (classifyError(err) !== "gone") throw err;
                await insertEvent(token, calendarId, eventId, desired);
            }
        } else {
            try {
                await insertEvent(token, calendarId, eventId, desired);
            } catch (err) {
                // The id exists (a retry, or a deleted event): replace it, which also revives it.
                if (classifyError(err) !== "conflict") throw err;
                await updateEvent(token, calendarId, eventId, desired);
            }
        }

        this.sql.exec(
            `INSERT INTO google_task_events (task_id, fingerprint, synced_at) VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE
               SET fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`,
            taskId, fp, new Date().toISOString(),
        );
    }

    /** Syncing stopped on its own; keep the reason for Settings. */
    private stopPush(reason: string, options: { calendarGone?: boolean } = {}): void {
        this.sql.exec("UPDATE google_account SET push_enabled = 0, push_error = ? WHERE id = 1", reason);
        this.sql.exec("DELETE FROM google_outbox");
        if (options.calendarGone) {
            this.sql.exec("UPDATE google_account SET dash_calendar_id = NULL WHERE id = 1");
            this.sql.exec("DELETE FROM google_task_events");
        }
    }

    private clearPushState(): void {
        this.sql.exec("DELETE FROM google_outbox");
        this.sql.exec("DELETE FROM google_task_events");
    }

    /** Off, or disconnecting: delete the dash calendar (best effort) and forget the sync state. */
    private async removeDashCalendar(): Promise<void> {
        const { calendarId } = this.pushState();
        if (calendarId) {
            try {
                const token = await this.getValidAccessToken();
                if (token) await deleteCalendar(token, calendarId);
            } catch (err) {
                // Already gone is fine; anything else leaves an orphan the user can delete in Google.
                if (classifyError(err) !== "gone") console.error("Could not delete the dash calendar", err);
            }
        }
        this.sql.exec(
            "UPDATE google_account SET push_enabled = 0, push_error = NULL, dash_calendar_id = NULL WHERE id = 1",
        );
        this.clearPushState();
        await this.storage.deleteAlarm();
    }
}

/** The user-zone days a window covers: from the start's day to the day before the end. */
function daysIn(startISO: string, endISO: string, timeZone: string): string[] {
    const first = civilFromDate(new Date(startISO), timeZone);
    const last = civilKey(civilFromDate(new Date(Date.parse(endISO) - 1), timeZone));
    const out: string[] = [];
    for (let d = first; civilKey(d) <= last && out.length < 62; d = addDays(d, 1)) out.push(civilKey(d));
    return out;
}
