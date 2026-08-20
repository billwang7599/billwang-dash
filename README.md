# dash

A Todoist-style todo list and calendar on Cloudflare Workers + Durable Objects,
with Todoist's quick-add grammar and read-only Google Calendar.

```
Design review #Work @deep p1 every other tuesday at 3pm for 90m
└─ content ──┘ └proj┘ └lab┘ └p┘ └── recurrence ──┘ └time┘ └dur┘
```

---

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in DEV_USER at minimum
npm run dev                      # http://localhost:5173
npm test
```

Locally there is no Access in front of the Worker, so `ACCESS_TEAM_DOMAIN` is
unset and `DEV_USER` from `.dev.vars` stands in as the signed-in user.

---

## Architecture

| Piece | Where | Why |
|---|---|---|
| Router + auth | `worker/index.ts`, `worker/auth.ts` | Identity resolved at the edge and passed down |
| Per-user data | `worker/user-do.ts` | One DO per user; all reads are local SQLite |
| Quick-add grammar | `shared/parser.ts` | Pure module, imported by both Worker and UI |
| Date math | `shared/civil.ts` | Wall-clock dates, not instants |
| Google Calendar | `worker/google.ts` | Read-only pull, tokens held in the DO |
| UI | `src/`, `index.html`, `app/index.html` | Static landing page + React SPA |

Three decisions worth knowing about:

**One Durable Object per user.** A user's tasks are only ever touched by that
user, so there is no cross-user contention and every query is a local SQLite
read that is strongly consistent with its writes. The DO is keyed by the Access
token's stable `sub` claim.

**Tasks store wall-clock dates, never instants.** A task is `2026-08-04` +
`17:00` + `America/Chicago`, not an epoch millisecond. "Tomorrow at 5pm" should
stay 5pm across a DST change or a flight, and it does. Conversion to a real
instant happens once, at the calendar boundary. `shared/civil.ts` holds that
math; `test/calendar.test.ts` pins the behaviour.

**One parser, two callers.** The UI parses on every keystroke to draw the live
preview; the Worker re-parses the raw text on submit. Because it is literally
the same module, the preview can never promise something the server won't
store. The client's parse is a hint, not the source of truth.

---

## Setting up Cloudflare Access

Access authenticates at the edge and injects a signed JWT as the
`Cf-Access-Jwt-Assertion` header. `worker/auth.ts` verifies that header against
your team's JWKS endpoint.

Create an Access application covering the protected paths:

```
<your-domain>/app*
<your-domain>/api*
```

Leave `/` out so the landing page stays public. Access applications match on
hostname **+ path**, and more specific paths win over their parents.

Then set the two values from the Worker's **Access tab → Application values**:

```jsonc
"ACCESS_TEAM_DOMAIN": "https://<your-team>.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>"
```

| Path | Access | Result |
|---|---|---|
| `/` | not covered | Public landing page |
| `/app*` | covered | Login screen, then the SPA |
| `/api*` | covered | JSON API |

### Why not `ctx.access`?

`ctx.access` is the nicer API — the runtime verifies the token for you — but it
is **unavailable to Workers that use Static Assets**. Per Cloudflare's docs:

> Workers with Static Assets execute behind an internal router Worker. Access
> still protects the application and its assets. However, the router does not
> pass `ctx.access` to the user Worker.

This Worker serves the landing page and SPA from `dist/client`, so `ctx.access`
is permanently `undefined` here no matter how Access is configured — confirmed
empirically with a raw pre-Hono `fetch` handler, on both `/app` and `/api`
paths. Note the docs also warn that `@cloudflare/vite-plugin` can add `assets`
even when your config omits it, so removing the binding is not a reliable fix.

Security is identical either way: it is the same Access-issued JWT, read from
the header rather than handed over by the runtime.

The alternative, if you ever want `ctx.access` back, is splitting into two
Workers — an API Worker with no assets (gets `ctx.access`) and a frontend
Worker that serves the assets and needs no identity.

### Admin routes

`ADMIN_EMAILS` and `ADMIN_GROUPS` (comma-separated) feed `isAdmin()` in
`worker/auth.ts`; `/api/admin/*` returns 403 without it. This is enforced in
code rather than by a second Access application so the rule lives in the repo
next to the routes it guards.

### Failing closed

`DEV_USER` lives in `.dev.vars`, which `wrangler deploy` never uploads. A
deploy that forgets to turn Access on therefore has no fallback identity and
rejects every request, rather than silently handing everyone one shared
account. Do not move `DEV_USER` into `vars`.

---

## Setting up Google Calendar

Read-only: your events show up beside scheduled tasks, and the app requests
only `calendar.readonly`, so it is incapable of writing to your calendar.

1. In Google Cloud, create a project and enable the **Google Calendar API**.
2. Create an **OAuth 2.0 Client ID** (Web application).
3. Add an authorised redirect URI of `<APP_ORIGIN>/api/google/callback` —
   `http://localhost:5173/api/google/callback` for local dev.
4. Set the secrets:

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

5. Set `APP_ORIGIN` in `wrangler.jsonc` to your deployed origin.
6. Connect from **Settings** inside the app.

Refresh tokens are stored in the user's Durable Object, which Cloudflare
encrypts at rest. An earlier version also encrypted them at the application
layer; that was dropped as over-engineering for a personal deployment, since it
added key management and a "lose the key, everyone reconnects" failure mode for
defence-in-depth that duplicated what the platform already provides.

---

## The quick-add grammar

| Syntax | Example | Result |
|---|---|---|
| Relative dates | `today`, `tomorrow`, `in 3 days`, `next week` | Due date |
| Weekdays | `friday`, `next monday`, `this weekend` | Next occurrence |
| Absolute dates | `jan 27`, `27 jan`, `2026-12-25`, `3/5` | Due date |
| Times | `at 5pm`, `17:00`, `noon`, `tomorrow morning` | Due time |
| Ranges | `3pm-4:30pm` | Start time **and** duration |
| Duration | `for 90m`, `for 2h` | Duration |
| Recurrence | `every day`, `every other tuesday`, `every! 3 days` | Repeat rule |
| Priority | `p1`–`p4`, `!!1` | 1 = urgent, 4 = default |
| Project | `#Work`, `#"Q3 Launch"` | Filed, created if new |
| Label | `@urgent`, `@"deep work"` | Tags, repeatable |
| Deadline | `{apr 15}` | Hard deadline, separate from due date |

**`every!` vs `every`.** A normal rule advances from the *scheduled* date, so a
daily task completed three days late doesn't fire three times catching up.
`every!` advances from the *completion* date — right for "change the filter
every 3 months", where what matters is when you last did it.

### Two heuristics you may want to change

**Bare hours guess am/pm.** `at 5` → 5pm, `at 9` → 9am (hours 1–7 read as
afternoon). See `toMinutes()` in `shared/parser.ts`.

**Numeric dates default to month-first.** `3/5` is 5 March. Switch to
day-first in Settings, or change the `dateFormat` default in the same file.

---

## Testing

```bash
npm test
```

103 tests via `@cloudflare/vitest-pool-workers`, running in the real Workers
runtime rather than a mock: the parser grammar, DO storage and recurrence
rollover, the public/protected split, and calendar timezone placement.

---

## Known gaps

- **Google events are fetched live on every calendar load**, not cached. Fine
  at personal scale. `syncToken`-based incremental sync is the next step if it
  gets chatty.
- **Google Calendar is read-only** — tasks are not pushed to Google. Writing
  back would need the `calendar.events` scope and conflict handling.
- **No realtime sync.** Two open tabs won't see each other's edits until
  reload. The DO already supports WebSocket hibernation if that's wanted.
- **`until` clauses are unsupported** — `every day until jan 1` parses the
  recurrence and ignores the bound.
- **Recurrence with an interval and specific weekdays is approximate.**
  `every other monday` is exact; `every 2 mon, wed` advances to the next listed
  weekday and only applies the interval on week wrap.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Vite + Worker, hot reload |
| `npm run build` | Typecheck and build both entries |
| `npm test` | Full suite |
| `npm run deploy` | Build and `wrangler deploy` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` |
