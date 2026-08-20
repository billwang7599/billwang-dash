import type { Project, Task } from "../../shared/types.ts";
import { formatDateLabel, formatDueLabel, priorityName } from "../format.ts";

interface Props {
  tasks: Task[];
  projects: Project[];
  timeZone: string;
  /** Groups by due date; off for a single project's list. */
  groupByDate?: boolean;
  emptyMessage: string;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (task: Task) => void;
}

export function TaskList({
  tasks,
  projects,
  timeZone,
  groupByDate = true,
  emptyMessage,
  onComplete,
  onDelete,
  onOpen,
}: Props) {
  if (tasks.length === 0) {
    return (
      <div className="empty">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const projectName = (id: string) =>
    projects.find((p) => p.id === id) ?? null;

  if (!groupByDate) {
    return (
      <ul className="tasks">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            project={projectName(task.projectId)}
            timeZone={timeZone}
            onComplete={onComplete}
            onDelete={onDelete}
            onOpen={onOpen}
          />
        ))}
      </ul>
    );
  }

  const groups = groupTasks(tasks);

  return (
    <>
      {groups.map(([label, groupTasks]) => (
        <section className="task-group" key={label}>
          <h3 className="group-head">
            {label === "none" ? "No date" : formatDateLabel(label, timeZone)}
            <span className="group-count">{groupTasks.length}</span>
          </h3>
          <ul className="tasks">
            {groupTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                project={projectName(task.projectId)}
                timeZone={timeZone}
                hideDate
                onComplete={onComplete}
                onDelete={onDelete}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function TaskRow({
  task,
  project,
  timeZone,
  hideDate,
  onComplete,
  onDelete,
  onOpen,
}: {
  task: Task;
  project: Project | null;
  timeZone: string;
  hideDate?: boolean;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (task: Task) => void;
}) {
  return (
    <li className={`task${task.completed ? " is-done" : ""}`}>
      <button
        className="check"
        data-p={task.priority}
        onClick={() => onComplete(task.id)}
        aria-label={`Complete ${task.content}`}
        title={priorityName(task.priority)}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M2.5 8.5l3.5 3.5 7.5-8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button className="task-body" onClick={() => onOpen(task)} aria-label={`Edit ${task.content}`}>
        <p className="task-title">{task.content}</p>
        <div className="task-meta">
          {task.due && !hideDate && (
            <span className="meta-due">{formatDueLabel(task.due, timeZone)}</span>
          )}
          {task.due && hideDate && (task.due.time || task.due.recurrence) && (
            <span className="meta-due">
              {formatDueLabel({ ...task.due, date: "" }, timeZone).replace(/^ · /, "")}
            </span>
          )}
          {task.deadline && <span className="meta-deadline">deadline {task.deadline}</span>}
          {project && !project.isInbox && <span className="meta-project">#{project.name}</span>}
          {task.labels.map((label) => (
            <span className="meta-label" key={label}>
              @{label}
            </span>
          ))}
        </div>
      </button>

      <button
        className="task-delete"
        onClick={() => onDelete(task.id)}
        aria-label={`Delete ${task.content}`}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </li>
  );
}

/** Buckets by due date, undated last, each bucket in date order. */
function groupTasks(tasks: Task[]): [string, Task[]][] {
  const buckets = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.due?.date ?? "none";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }

  return [...buckets.entries()].sort(([a], [b]) => {
    if (a === "none") return 1;
    if (b === "none") return -1;
    return a.localeCompare(b);
  });
}
