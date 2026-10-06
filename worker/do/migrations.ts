import { INBOX_ID } from "./common.ts";

/**
 * Schema history, oldest first. UserDO runs every entry newer than the highest version
 * recorded in its _migrations table, then records it. Never edit an entry that has shipped:
 * add a new one.
 */
export interface Migration {
    version: number;
    sql: string;
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
];
