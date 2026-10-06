/**
 * Google Calendar client. Reads use `calendar.readonly`. Writes use
 * `calendar.app.created`, which only reaches calendars this app created, so
 * dash can never modify a user's own calendars or events.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Create dash's own calendar and manage events on it, nothing else. */
export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

const SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    WRITE_SCOPE,
    "openid",
    "email",
];

export interface GoogleTokens {
    accessToken: string;
    refreshToken: string | null;
    /** Epoch millis. */
    expiresAt: number;
    email: string | null;
    /** Space-separated scopes Google actually granted; the user can untick some. */
    scope: string | null;
}

interface GoogleCalendarEntry {
    id: string;
    summary: string;
    color: string;
    primary: boolean;
}

export interface GoogleEvent {
    id: string;
    summary: string;
    start: string;
    end: string;
    allDay: boolean;
    htmlLink?: string;
    location?: string;
    description?: string;
    /** Set on events dash wrote, so they aren't shown twice. */
    dashTaskId?: string;
}

type EventTime = { date: string } | { dateTime: string; timeZone: string };

/** The slice of a Google event resource that dash writes. */
export interface GoogleEventPayload {
    summary: string;
    description?: string;
    start: EventTime;
    end: EventTime;
    transparency?: "transparent" | "opaque";
    extendedProperties: { private: { dashTaskId: string } };
}

/** A failed Google API call, with the status and Google's own reason code. */
export class GoogleApiError extends Error {
    constructor(
        readonly status: number,
        readonly reason: string | null,
        message: string,
    ) {
        super(message);
    }
}

function redirectUri(env: Env): string {
    return `${env.APP_ORIGIN.replace(/\/+$/, "")}/api/google/callback`;
}

export function buildAuthUrl(env: Env, state: string): string {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri(env));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    // `offline` + `consent` guarantees a refresh token even when the user has
    // authorised this app before; Google omits it on repeat grants otherwise.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
}

export async function exchangeCode(env: Env, code: string): Promise<GoogleTokens> {
    return tokenRequest(env, {
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri(env),
    });
}

export async function refreshAccessToken(
    env: Env,
    refreshToken: string,
): Promise<GoogleTokens> {
    const tokens = await tokenRequest(env, {
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    });
    // Refresh responses omit the refresh token; keep the one we already hold.
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

async function tokenRequest(
    env: Env,
    params: Record<string, string>,
): Promise<GoogleTokens> {
    const body = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        ...params,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!res.ok) {
        throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
    }

    const json = await res.json<{
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        id_token?: string;
        scope?: string;
    }>();

    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresAt: Date.now() + json.expires_in * 1000,
        email: json.id_token ? emailFromIdToken(json.id_token) : null,
        scope: json.scope ?? null,
    };
}

/**
 * Reads the email claim without verifying the signature — safe because the
 * token came straight from Google's endpoint over TLS, not from a client.
 */
function emailFromIdToken(idToken: string): string | null {
    try {
        const payload = idToken.split(".")[1];
        const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
        return (JSON.parse(json) as { email?: string }).email ?? null;
    } catch {
        return null;
    }
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarEntry[]> {
    const res = await apiRequest(
        "GET",
        `${CALENDAR_API}/users/me/calendarList?minAccessRole=reader&maxResults=250`,
        accessToken,
    );
    const json = await res.json<{
        items?: Array<{
            id: string;
            summary?: string;
            backgroundColor?: string;
            primary?: boolean;
        }>;
    }>();

    return (json.items ?? []).map((c) => ({
        id: c.id,
        summary: c.summary ?? c.id,
        color: c.backgroundColor ?? "#4285f4",
        primary: c.primary === true,
    }));
}

export async function listEvents(
    accessToken: string,
    calendarId: string,
    timeMin: string,
    timeMax: string,
): Promise<GoogleEvent[]> {
    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    // Expand recurring events so the calendar view needn't understand RRULE.
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");

    const res = await apiRequest("GET", url.toString(), accessToken);
    const json = await res.json<{
        items?: Array<{
            id: string;
            status?: string;
            summary?: string;
            htmlLink?: string;
            location?: string;
            description?: string;
            extendedProperties?: { private?: { dashTaskId?: string } };
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
        }>;
    }>();

    return (json.items ?? [])
        .filter((e) => e.status !== "cancelled" && (e.start?.dateTime || e.start?.date))
        .map((e) => {
            const allDay = !e.start?.dateTime;
            return {
                id: e.id,
                summary: e.summary ?? "(no title)",
                // All-day events carry a bare YYYY-MM-DD; normalise to an instant so
                // the client only ever deals with one shape.
                start: e.start?.dateTime ?? `${e.start?.date}T00:00:00.000Z`,
                end: e.end?.dateTime ?? `${e.end?.date ?? e.start?.date}T00:00:00.000Z`,
                allDay,
                htmlLink: e.htmlLink,
                location: e.location,
                description: e.description,
                dashTaskId: e.extendedProperties?.private?.dashTaskId,
            };
        });
}

// ---- Writes (dash's own calendar only) -------------------------------------

/** Returns the new calendar's id. */
export async function createCalendar(
    accessToken: string,
    summary: string,
    timeZone: string,
): Promise<string> {
    const res = await apiRequest("POST", `${CALENDAR_API}/calendars`, accessToken, {
        summary,
        timeZone,
    });
    return (await res.json<{ id: string }>()).id;
}

export async function deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    await apiRequest("DELETE", `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`, accessToken);
}

const eventsUrl = (calendarId: string) =>
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

/** The caller picks the id, so a retried insert answers 409 rather than duplicating. */
export async function insertEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    payload: GoogleEventPayload,
): Promise<void> {
    await apiRequest("POST", eventsUrl(calendarId), accessToken, { ...payload, id: eventId });
}

/**
 * Full replace (PUT), not PATCH: patch merges nested objects, so switching an
 * event between all-day and timed would leave both `date` and `dateTime` set.
 * `status: "confirmed"` also revives an event that was deleted.
 */
export async function updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    payload: GoogleEventPayload,
): Promise<void> {
    await apiRequest(
        "PUT",
        `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
        accessToken,
        { ...payload, id: eventId, status: "confirmed" },
    );
}

export async function deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
): Promise<void> {
    await apiRequest(
        "DELETE",
        `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
        accessToken,
    );
}

async function apiRequest(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    accessToken: string,
    body?: unknown,
): Promise<Response> {
    const res = await fetch(url, {
        method,
        headers: {
            authorization: `Bearer ${accessToken}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new GoogleApiError(res.status, reasonFrom(text), `Google Calendar API ${res.status}: ${text}`);
    }
    return res;
}

/** Google's machine-readable reason, e.g. "rateLimitExceeded" or "insufficientPermissions". */
function reasonFrom(text: string): string | null {
    try {
        const err = (JSON.parse(text) as {
            error?: { errors?: Array<{ reason?: string }>; status?: string };
        }).error;
        return err?.errors?.[0]?.reason ?? err?.status ?? null;
    } catch {
        return null;
    }
}
