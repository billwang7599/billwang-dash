---
name: dash
description: Read and change the user's dash dashboard (tasks, projects, calendar events, habits, goals) with the `dash` CLI. Use when the user asks about their todos, schedule, habits or goals, or to add, update or complete them.
---

# dash

1. `dash help` lists the tools, one per line: name, read or write, what it does.
2. `dash help <tool>` gives the full description and its args as JSON Schema.
3. `dash <tool> '<json args>'` runs it and prints JSON. Tools with no args need no JSON.

Start with `dash get_overview` to find ids before acting on anything the user names; never guess ids. To add a task,
prefer `quick_add_task` with the date, `#Project` and priority in the text, the way the user would type it.

Writes happen at once, with no confirmation step, so only make changes the user asked for. `delete_task` moves a
task to the trash, where the user can restore it.

On "not logged in" or "token rejected", ask the user to make a token in dash Settings and run `dash login <token>`.
