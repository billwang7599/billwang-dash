/**
 * Google Calendar client. Read-only by construction: the scope is
 * `calendar.readonly`, so this cannot modify anyone's calendar.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch millis. */
  expiresAt: number;
  email: string | null;
}

interface GoogleCalendarEntry {
  id: string;
  summary: string;
  color: string;
  primary: boolean;
}

interface GoogleEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  htmlLink?: string;
  location?: string;
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
  }>();

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
    email: json.id_token ? emailFromIdToken(json.id_token) : null,
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
  const res = await apiGet(
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

  const res = await apiGet(url.toString(), accessToken);
  const json = await res.json<{
    items?: Array<{
      id: string;
      status?: string;
      summary?: string;
      htmlLink?: string;
      location?: string;
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
      };
    });
}

async function apiGet(url: string, accessToken: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google Calendar API ${res.status}: ${await res.text()}`);
  }
  return res;
}
