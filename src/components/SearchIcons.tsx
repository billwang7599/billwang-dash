/** Line icons for search: the magnifier, and one per kind of result (a folder, a task's circle, a calendar, a tick). */

const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
} as const;

export function SearchIcon() {
    return (
        <svg {...props} className="search-icon">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </svg>
    );
}

export type ResultKind = "project" | "task" | "event" | "habit";

const paths: Record<ResultKind, React.ReactNode> = {
    project: <path d="M3 7h7l2 2h9v10H3z" />,
    task: <circle cx="12" cy="12" r="8" />,
    event: (
        <>
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M4 10h16" />
        </>
    ),
    habit: <path d="M5 13l4 4L19 7" />,
};

export function KindIcon({ kind }: { kind: ResultKind }) {
    return <svg {...props}>{paths[kind]}</svg>;
}
