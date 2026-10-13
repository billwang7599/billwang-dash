import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SharedTask, SharedView } from "../shared/share.ts";
import { PROJECT_COLORS, type ProjectColor } from "../shared/types.ts";
import "./app.css";
import { isLang, LANGUAGES, matchLanguage, pickLanguage, translate, type Key, type Lang } from "./shareI18n.ts";

/**
 * The page behind a project's share link: its open tasks, an add box, and a tick. No
 * sign-in; the token in the URL is the credential (see worker/index.ts). Same cards and
 * rows as the app, without the sidebar.
 */

const base = window.location.pathname.replace(/\/+$/, "");

/** The server's words are English; the page picks its own text from the status. */
class CallError extends Error {
    constructor(readonly status: number) {
        super(`Request failed (${status})`);
    }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" } });
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new CallError(res.status);
    return (await res.json()) as T;
}

const STORAGE_KEY = "share-lang";

/**
 * `?lang=fr` in the link wins, so the sender can pick the language; it is then taken out of the
 * address so it doesn't override the dropdown on a reload. Otherwise the visitor's saved choice,
 * else the browser's language. Storage can be blocked, so it is optional.
 */
function initialLanguage(): Lang {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("lang");
    if (requested !== null) {
        url.searchParams.delete("lang");
        window.history.replaceState(null, "", url);
        const lang = matchLanguage(requested);
        if (lang) return lang;
    }
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (isLang(saved)) return saved;
    } catch {
        // private window or blocked storage: fall through
    }
    return pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

const colorOf = (name: string) =>
    (PROJECT_COLORS as readonly string[]).includes(name) ? `var(--c-${name as ProjectColor})` : "var(--c-stone)";

function SharedPage() {
    const [view, setView] = useState<SharedView | null>(null);
    const [dead, setDead] = useState(false);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<Key | null>(null);
    const [lang, setLang] = useState<Lang>(initialLanguage);
    const t = (key: Key, vars?: Record<string, string>) => translate(lang, key, vars);

    useEffect(() => {
        call<SharedView>("/data").then(setView, () => setDead(true));
    }, []);

    useEffect(() => {
        document.documentElement.lang = lang;
        try {
            localStorage.setItem(STORAGE_KEY, lang);
        } catch {
            // not remembered; the browser's language is used next time
        }
    }, [lang]);

    const failure = (err: unknown): Key => (err instanceof CallError && err.status === 429 ? "limit" : "failed");

    useEffect(() => {
        if (view) document.title = view.projectName;
    }, [view]);

    const picker = (
        <select className="pub-lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("language")}>
            {Object.entries(LANGUAGES).map(([code, name]) => (
                <option key={code} value={code}>
                    {name}
                </option>
            ))}
        </select>
    );

    if (dead) {
        return (
            <main className="pub">
                <div className="pub-bar">{picker}</div>
                <div className="pub-dead">
                    <h1>{t("deadTitle")}</h1>
                    <p className="modal-note">{t("deadBody")}</p>
                </div>
            </main>
        );
    }
    if (!view) return <main className="pub" />;

    const limitReached = view.remaining === 0;
    const openCount = view.tasks.filter((task) => !task.completed).length;

    async function add(e: React.FormEvent) {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { task } = await call<{ task: SharedTask }>("/tasks", { method: "POST", body: JSON.stringify({ text }) });
            setView((v) => v && { ...v, tasks: [...v.tasks, task], remaining: Math.max(0, v.remaining - 1) });
            setText("");
        } catch (err) {
            setError(failure(err));
            // The server's count is the truth: pick up a spent limit or a rotated link.
            call<SharedView>("/data").then(setView, () => setDead(true));
        } finally {
            setBusy(false);
        }
    }

    async function complete(task: SharedTask) {
        // Ticked tasks stay, struck through, and move below the open ones like they will on reload.
        const mark = (completed: boolean) =>
            setView((v) => {
                if (!v) return v;
                const tasks = v.tasks.map((x) => (x.id === task.id ? { ...x, completed } : x));
                return { ...v, tasks: [...tasks.filter((x) => !x.completed), ...tasks.filter((x) => x.completed)] };
            });
        mark(true);
        try {
            await call(`/tasks/${task.id}/complete`, { method: "POST" });
        } catch (err) {
            mark(false);
            setError(failure(err));
        }
    }

    return (
        <main className="pub">
            <div className="pub-bar">{picker}</div>
            {view.ownerName && <p className="pub-by">{t("sharedBy", { name: view.ownerName })}</p>}
            <h1>{view.projectName}</h1>

            <form className="quickadd" onSubmit={add}>
                <div className="qa-field">
                    <div className="qa-input-wrap">
                        <input
                            className="qa-input"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder={t("addPlaceholder")}
                            aria-label={t("addLabel")}
                            autoComplete="off"
                            maxLength={200}
                            disabled={limitReached}
                        />
                    </div>
                    <button className="qa-submit" type="submit" disabled={!text.trim() || busy || limitReached}>
                        {busy ? t("adding") : t("add")}
                    </button>
                </div>
                {(error || limitReached) && <p className="qa-error">{t(error ?? "limit")}</p>}
            </form>

            {view.tasks.length > 0 ? (
                <div className="stack" style={{ ["--card-c" as string]: colorOf(view.color) }}>
                    <section className="tcard">
                        <h2 className="tcard-head">
                            {t("todo")} <span>{openCount}</span>
                        </h2>
                        <ul className="tasks">
                            {view.tasks.map((task) => (
                                <li key={task.id} className={`task${task.completed ? " is-done" : ""}`}>
                                    <button
                                        className="check"
                                        data-p="4"
                                        onClick={() => complete(task)}
                                        disabled={task.completed}
                                        aria-label={t(task.completed ? "completed" : "complete", { task: task.content })}
                                    >
                                        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                                            <path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                    </button>
                                    <div className="task-main">
                                        <p className="task-title">
                                            {task.content}
                                            {task.viaLink && <span className="tag pub-via">{t("viaLink")}</span>}
                                        </p>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </section>
                </div>
            ) : (
                <div className="empty">
                    <p>{t("empty")}</p>
                </div>
            )}
            <p className="pub-note">{t("note")}</p>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <SharedPage />
    </StrictMode>,
);
