/** A project's share link, as the owner sees it. */
export interface ShareInfo {
    enabled: boolean;
    /** Null while sharing is off. The page URL is built from it; see worker/index.ts. */
    token: string | null;
    /** Tasks a day that visitors may add through the link. */
    limit: number;
    usedToday: number;
}

/** What a visitor opening the link sees: the project's open tasks, nothing else of the owner's. */
export interface SharedView {
    projectName: string;
    color: string;
    /** The owner's first name, if they set one. */
    ownerName: string | null;
    tasks: SharedTask[];
    /** Adds left today before the limit. */
    remaining: number;
}

export interface SharedTask {
    id: string;
    content: string;
    viaLink: boolean;
    /** Only tasks added through the link stay on the page once ticked off. */
    completed: boolean;
}

/** How many ticked-off tasks the page keeps showing, newest last. */
export const SHARE_MAX_DONE = 50;

export const SHARE_DEFAULT_LIMIT = 25;
export const SHARE_MAX_LIMIT = 500;
export const SHARE_MAX_CONTENT = 200;
