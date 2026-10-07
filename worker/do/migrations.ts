import { civilFromKey, parseTimeToMinutes, zonedToUtcMs } from "../../shared/civil.ts";
import { INBOX_ID } from "./common.ts";
import { END_OF_DAY_MINUTES, toMs } from "./time.ts";

/**
 * Schema history, oldest first. UserDO runs every entry newer than the highest version
 * recorded in its _migrations table, then records it. Never edit an entry that has shipped:
 * add a new one.
 */
export interface Migration {
    version: number;
    sql: string;
    /** Data work SQL can't do (time zones), run right after `sql` in the same version. */
    after?: (sql: SqlStorage) => void;
}

/**
 * Gives every task that has a due_date a due_at instant, read in the profile's zone
 * (the only zone the old wall-clock columns ever meant). Date-only tasks land on the
 * end of their day. The old due_date/due_time columns are left behind, unused.
 */
export function backfillDueAt(sql: SqlStorage): void {
    const zone = sql.exec<{ time_zone: string }>("SELECT time_zone FROM profile WHERE id = 1").one().time_zone;
    const rows = sql
        .exec<{ id: string; due_date: string; due_time: string | null }>(
            "SELECT id, due_date, due_time FROM tasks WHERE due_date IS NOT NULL AND due_at IS NULL",
        )
        .toArray();
    for (const r of rows) {
        const civil = civilFromKey(r.due_date);
        if (!civil) continue;
        const minutes = r.due_time ? parseTimeToMinutes(r.due_time) : END_OF_DAY_MINUTES;
        sql.exec(
            "UPDATE tasks SET due_at = ?, due_tz = ?, due_has_time = ? WHERE id = ?",
            zonedToUtcMs(civil, minutes, zone), zone, r.due_time ? 1 : 0, r.id,
        );
    }
}

/** The end of a calendar day in `zone`, as epoch ms; what a date with no time means. */
const endOfDay = (date: string, zone: string): number => {
    const civil = civilFromKey(date);
    return civil ? zonedToUtcMs(civil, END_OF_DAY_MINUTES, zone) : 0;
};

/**
 * Fills the columns migration 23 added, from the text ones they replace. Dates are read
 * in the profile's zone, the only zone they ever meant. Unparseable timestamps become 0.
 */
export function backfillInstants(sql: SqlStorage): void {
    const zone = sql.exec<{ time_zone: string }>("SELECT time_zone FROM profile WHERE id = 1").one().time_zone;
    const rows = <T extends Record<string, SqlStorageValue>>(query: string) => sql.exec<T>(query).toArray();
    const ms = (iso: SqlStorageValue) => toMs(iso as string | null);

    for (const r of rows<{ id: string; deadline: string | null; created_at: string; updated_at: string; completed_at: string | null; deleted_at: string | null }>(
        "SELECT id, deadline, created_at, updated_at, completed_at, deleted_at FROM tasks",
    )) {
        sql.exec(
            `UPDATE tasks SET deadline_at = ?, deadline_tz = ?, created_ms = ?, updated_ms = ?,
                              completed_ms = ?, deleted_ms = ? WHERE id = ?`,
            r.deadline ? endOfDay(r.deadline, zone) : null, r.deadline ? zone : null,
            ms(r.created_at) ?? 0, ms(r.updated_at) ?? 0, ms(r.completed_at), ms(r.deleted_at), r.id,
        );
    }
    for (const r of rows<{ id: string; created_at: string; deleted_at: string | null }>(
        "SELECT id, created_at, deleted_at FROM projects",
    )) {
        sql.exec("UPDATE projects SET created_ms = ?, deleted_ms = ? WHERE id = ?", ms(r.created_at) ?? 0, ms(r.deleted_at), r.id);
    }
    for (const r of rows<{ id: string; created_at: string }>("SELECT id, created_at FROM habits")) {
        sql.exec("UPDATE habits SET created_ms = ? WHERE id = ?", ms(r.created_at) ?? 0, r.id);
    }
    for (const r of rows<{ habit_id: string; day: string; created_at: string }>(
        "SELECT habit_id, day, created_at FROM habit_checkins",
    )) {
        sql.exec(
            "UPDATE habit_checkins SET created_ms = ? WHERE habit_id = ? AND day = ?",
            ms(r.created_at) ?? 0, r.habit_id, r.day,
        );
    }
    for (const r of rows<{ id: string; deadline: string; created_at: string; updated_at: string }>(
        "SELECT id, deadline, created_at, updated_at FROM goals",
    )) {
        sql.exec(
            "UPDATE goals SET deadline_at = ?, deadline_tz = ?, created_ms = ?, updated_ms = ? WHERE id = ?",
            endOfDay(r.deadline, zone), zone, ms(r.created_at) ?? 0, ms(r.updated_at) ?? 0, r.id,
        );
    }
    for (const r of rows<{ connected_at: string; last_synced_at: string | null }>(
        "SELECT connected_at, last_synced_at FROM google_account",
    )) {
        sql.exec("UPDATE google_account SET connected_ms = ?, last_synced_ms = ?", ms(r.connected_at) ?? 0, ms(r.last_synced_at));
    }
    for (const r of rows<{ task_id: string; synced_at: string }>("SELECT task_id, synced_at FROM google_task_events")) {
        sql.exec("UPDATE google_task_events SET synced_ms = ? WHERE task_id = ?", ms(r.synced_at) ?? 0, r.task_id);
    }
    for (const r of rows<{
        id: string; title: string; description: string; start_date: string; start_time: string | null;
        end_date: string; end_time: string | null; created_at: string; updated_at: string;
    }>("SELECT * FROM events")) {
        const allDay = r.start_time === null || r.end_time === null;
        const first = civilFromKey(r.start_date);
        const last = civilFromKey(r.end_date);
        sql.exec(
            `INSERT INTO events_new (id, title, description, all_day, start_date, end_date, start_at, end_at, tz, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            r.id, r.title, r.description, allDay ? 1 : 0,
            allDay ? r.start_date : null, allDay ? r.end_date : null,
            allDay || !first ? null : zonedToUtcMs(first, parseTimeToMinutes(r.start_time!), zone),
            allDay || !last ? null : zonedToUtcMs(last, parseTimeToMinutes(r.end_time!), zone),
            allDay ? null : zone, ms(r.created_at) ?? 0, ms(r.updated_at) ?? 0,
        );
    }
}

export const migrations: Migration[] = [
    // Every user starts with an Inbox, matching Todoist's default target for
    // tasks created without a project.
    {
        version: 1,
        sql: `
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT 'slate',
                is_inbox INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                priority INTEGER NOT NULL DEFAULT 4,
                due_date TEXT,
                due_time TEXT,
                due_tz TEXT,
                recurrence TEXT,
                deadline TEXT,
                duration_minutes INTEGER,
                completed INTEGER NOT NULL DEFAULT 0,
                completed_at TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX idx_tasks_due ON tasks(completed, due_date);
            CREATE INDEX idx_tasks_project ON tasks(project_id, completed);

            CREATE TABLE task_labels (
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                PRIMARY KEY (task_id, label)
            );

            CREATE TABLE profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                email TEXT,
                name TEXT,
                time_zone TEXT NOT NULL DEFAULT 'UTC',
                date_format TEXT NOT NULL DEFAULT 'MDY'
            );

            INSERT INTO projects (id, name, color, is_inbox, sort_order) VALUES ('${INBOX_ID}', 'Inbox', 'slate', 1, 0);
            INSERT INTO profile (id) VALUES (1);
        `,
    },
    {
        version: 2,
        sql: `
            CREATE TABLE google_account (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                email TEXT,
                refresh_token TEXT NOT NULL,
                access_token TEXT,
                expires_at INTEGER NOT NULL DEFAULT 0,
                connected_at TEXT NOT NULL,
                last_synced_at TEXT
            );

            CREATE TABLE google_calendars (
                id TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                color TEXT NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE oauth_state (
                state TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );
        `,
    },
    // Dropped again in migration 6; nav is two fixed items now.
    {
        version: 3,
        sql: `
            ALTER TABLE profile ADD COLUMN nav_order TEXT NOT NULL DEFAULT '';
        `,
    },
    // '' means "created before this column existed" -- sorts as oldest,
    // the honest answer since the real creation time isn't known.
    {
        version: 4,
        sql: `
            ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
        `,
    },
    {
        version: 5,
        sql: `
            ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        `,
    },
    {
        version: 6,
        sql: `
            ALTER TABLE profile DROP COLUMN nav_order;
        `,
    },
    // Due times are floating: read in the profile's zone, so a per-task zone
    // would only ever be stale.
    {
        version: 7,
        sql: `
            ALTER TABLE tasks DROP COLUMN due_tz;
        `,
    },
    {
        version: 8,
        sql: `
            DROP TABLE task_labels;
        `,
    },
    // Soft delete. trashed_with is the project whose deletion took a task to
    // the trash, so a restore knows which tasks went with it. NULL means the
    // task was trashed on its own.
    {
        version: 9,
        sql: `
            ALTER TABLE projects ADD COLUMN deleted_at TEXT;
            ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
            ALTER TABLE tasks ADD COLUMN trashed_with TEXT;
        `,
    },
    // Existing accounts that moved off the UTC default already chose a zone.
    {
        version: 10,
        sql: `
            ALTER TABLE profile ADD COLUMN time_zone_set INTEGER NOT NULL DEFAULT 0;
            UPDATE profile SET time_zone_set = 1 WHERE time_zone != 'UTC';
        `,
    },
    // Pushing tasks to a dash-owned Google calendar. google_task_events has no
    // foreign key on purpose: a purged task must still be reconciled to a delete.
    // rev bumps on every edit, so a run that finishes can tell its work is stale.
    {
        version: 11,
        sql: `
            ALTER TABLE google_account ADD COLUMN scope TEXT;
            ALTER TABLE google_account ADD COLUMN dash_calendar_id TEXT;
            ALTER TABLE google_account ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE google_account ADD COLUMN push_error TEXT;

            CREATE TABLE google_task_events (
                task_id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                synced_at TEXT NOT NULL
            );

            CREATE TABLE google_outbox (
                task_id TEXT PRIMARY KEY,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_try_at INTEGER NOT NULL,
                rev INTEGER NOT NULL DEFAULT 1
            );
        `,
    },
    // Habits. A day with no check-in row is simply not done; "skipped" is an
    // excused day. start_date is when counting begins (a later check-in on an
    // earlier day moves it back, see summarizeHabits).
    {
        version: 12,
        sql: `
            CREATE TABLE habits (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                freq TEXT NOT NULL CHECK (freq IN ('daily', 'weekly_count', 'weekdays')),
                per_week INTEGER,
                weekdays TEXT NOT NULL DEFAULT '[]',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                start_date TEXT NOT NULL
            );

            CREATE TABLE habit_checkins (
                habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
                day TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('done', 'skipped')),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (habit_id, day)
            );
        `,
    },
    // dash's own calendar events. Wall-clock like tasks; null times mean all-day,
    // and end_date is the last day (inclusive).
    {
        version: 13,
        sql: `
            CREATE TABLE events (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                start_date TEXT NOT NULL,
                start_time TEXT,
                end_date TEXT NOT NULL,
                end_time TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX idx_events_range ON events(start_date, end_date);
        `,
    },
    {
        version: 14,
        sql: `
            ALTER TABLE habits ADD COLUMN description TEXT NOT NULL DEFAULT '';
        `,
    },
    // SMART goals. The horizon is picked by hand; done is current >= target.
    {
        version: 15,
        sql: `
            CREATE TABLE goals (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                why TEXT NOT NULL DEFAULT '',
                horizon TEXT NOT NULL CHECK (horizon IN ('short', 'medium', 'long')),
                target REAL NOT NULL,
                current REAL NOT NULL DEFAULT 0,
                unit TEXT NOT NULL DEFAULT '',
                deadline TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
    // A null target makes a yes/no goal. SQLite can't drop NOT NULL in place,
    // so the table is rebuilt.
    {
        version: 16,
        sql: `
            CREATE TABLE goals_new (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                why TEXT NOT NULL DEFAULT '',
                horizon TEXT NOT NULL CHECK (horizon IN ('short', 'medium', 'long')),
                target REAL,
                current REAL NOT NULL DEFAULT 0,
                unit TEXT NOT NULL DEFAULT '',
                deadline TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO goals_new SELECT * FROM goals;
            DROP TABLE goals;
            ALTER TABLE goals_new RENAME TO goals;
        `,
    },
    // Projects the Inbox leaves out, as a JSON array of ids. Hidden rather than
    // shown, so a new project appears without anyone opting it in.
    {
        version: 17,
        sql: `
            ALTER TABLE profile ADD COLUMN inbox_hidden_projects TEXT NOT NULL DEFAULT '[]';
        `,
    },
    // A task can be a step toward a goal. Deleting the goal keeps its tasks.
    {
        version: 18,
        sql: `
            ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL;
            CREATE INDEX idx_tasks_goal ON tasks(goal_id);
        `,
    },
    // Goals the Inbox leaves out (their steps), alongside the hidden projects.
    {
        version: 19,
        sql: `
            ALTER TABLE profile ADD COLUMN inbox_hidden_goals TEXT NOT NULL DEFAULT '[]';
        `,
    },
    // The user's own name, entered once at setup. Access gives no name, so the
    // old "name" column (synced from the login) stays as it was.
    {
        version: 20,
        sql: `
            ALTER TABLE profile ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
            ALTER TABLE profile ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
        `,
    },
    // A cache of the user's Google events, so the calendar doesn't call Google on
    // every view. gcal_cache_days says when each calendar's day was last fetched;
    // gcal_cache_events holds what came back. See worker/do/gcal-cache.ts.
    {
        version: 21,
        sql: `
            CREATE TABLE gcal_cache_days (
                calendar_id TEXT NOT NULL,
                day TEXT NOT NULL,
                synced_at INTEGER NOT NULL,
                PRIMARY KEY (calendar_id, day)
            );
            CREATE TABLE gcal_cache_events (
                calendar_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                start TEXT NOT NULL,
                end TEXT NOT NULL,
                all_day INTEGER NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (calendar_id, event_id)
            );
            CREATE INDEX idx_gcal_cache_events_start ON gcal_cache_events(calendar_id, start);
        `,
    },
    // Due dates become instants: due_at is epoch ms, due_tz the zone it was set in (so a
    // repeating task keeps its local time there), due_has_time 0 for a date-only task,
    // which sits on the end of its day. due_date/due_time are no longer written.
    {
        version: 22,
        sql: `
            ALTER TABLE tasks ADD COLUMN due_at INTEGER;
            ALTER TABLE tasks ADD COLUMN due_tz TEXT;
            ALTER TABLE tasks ADD COLUMN due_has_time INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX idx_tasks_due_at ON tasks(completed, due_at);
        `,
        after: backfillDueAt,
    },
    // Everything else that was text becomes epoch ms: bookkeeping timestamps everywhere,
    // task and goal deadlines (end of their day, like a date-only due date, plus the
    // zone they were set in), and timed events (start_at/end_at; an all-day event stays
    // a plain date). New columns are added and filled here; version 24 swaps them in.
    {
        version: 23,
        sql: `
            ALTER TABLE tasks ADD COLUMN deadline_at INTEGER;
            ALTER TABLE tasks ADD COLUMN deadline_tz TEXT;
            ALTER TABLE tasks ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE tasks ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE tasks ADD COLUMN completed_ms INTEGER;
            ALTER TABLE tasks ADD COLUMN deleted_ms INTEGER;

            ALTER TABLE projects ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE projects ADD COLUMN deleted_ms INTEGER;

            ALTER TABLE habits ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE habit_checkins ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;

            ALTER TABLE goals ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE goals ADD COLUMN deadline_tz TEXT;
            ALTER TABLE goals ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE goals ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0;

            ALTER TABLE google_account ADD COLUMN connected_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE google_account ADD COLUMN last_synced_ms INTEGER;
            ALTER TABLE google_task_events ADD COLUMN synced_ms INTEGER NOT NULL DEFAULT 0;

            CREATE TABLE events_new (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                all_day INTEGER NOT NULL,
                start_date TEXT,
                end_date TEXT,
                start_at INTEGER,
                end_at INTEGER,
                tz TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `,
        after: backfillInstants,
    },
    {
        version: 24,
        sql: `
            DROP INDEX idx_tasks_due;
            ALTER TABLE tasks DROP COLUMN due_date;
            ALTER TABLE tasks DROP COLUMN due_time;
            ALTER TABLE tasks DROP COLUMN deadline;
            ALTER TABLE tasks DROP COLUMN created_at;
            ALTER TABLE tasks DROP COLUMN updated_at;
            ALTER TABLE tasks DROP COLUMN completed_at;
            ALTER TABLE tasks DROP COLUMN deleted_at;
            ALTER TABLE tasks RENAME COLUMN created_ms TO created_at;
            ALTER TABLE tasks RENAME COLUMN updated_ms TO updated_at;
            ALTER TABLE tasks RENAME COLUMN completed_ms TO completed_at;
            ALTER TABLE tasks RENAME COLUMN deleted_ms TO deleted_at;

            ALTER TABLE projects DROP COLUMN created_at;
            ALTER TABLE projects DROP COLUMN deleted_at;
            ALTER TABLE projects RENAME COLUMN created_ms TO created_at;
            ALTER TABLE projects RENAME COLUMN deleted_ms TO deleted_at;

            ALTER TABLE habits DROP COLUMN created_at;
            ALTER TABLE habits RENAME COLUMN created_ms TO created_at;
            ALTER TABLE habit_checkins DROP COLUMN created_at;
            ALTER TABLE habit_checkins RENAME COLUMN created_ms TO created_at;

            ALTER TABLE goals DROP COLUMN deadline;
            ALTER TABLE goals DROP COLUMN created_at;
            ALTER TABLE goals DROP COLUMN updated_at;
            ALTER TABLE goals RENAME COLUMN created_ms TO created_at;
            ALTER TABLE goals RENAME COLUMN updated_ms TO updated_at;

            ALTER TABLE google_account DROP COLUMN connected_at;
            ALTER TABLE google_account DROP COLUMN last_synced_at;
            ALTER TABLE google_account RENAME COLUMN connected_ms TO connected_at;
            ALTER TABLE google_account RENAME COLUMN last_synced_ms TO last_synced_at;
            ALTER TABLE google_task_events DROP COLUMN synced_at;
            ALTER TABLE google_task_events RENAME COLUMN synced_ms TO synced_at;

            DROP TABLE events;
            ALTER TABLE events_new RENAME TO events;
            CREATE INDEX idx_events_timed ON events(start_at, end_at);
            CREATE INDEX idx_events_days ON events(start_date, end_date);
        `,
    },
];
