import type { Project, Task } from "../shared/types.ts";

/** The confirm text for deleting a project, shared by the sidebar and the Projects page. */
export function projectDeleteMessage(project: Project, tasks: Task[]): string {
    const n = tasks.filter((t) => t.projectId === project.id).length;
    const detail = n > 0 ? ` and its ${n} open task${n === 1 ? "" : "s"}` : "";
    return `"${project.name}"${detail} will move to Recently deleted. You can restore them from there.`;
}
