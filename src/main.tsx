import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, preloadView } from "./App.tsx";
import { api, type AppState } from "./api.ts";
import { restoreRange } from "./calendarCache.ts";
import { quietRead } from "./liveRefresh.ts";
import { openCache } from "./localCache.ts";
import "./app.css";

// Null if an edit made on the saved copy overlapped it.
const fresh = quietRead(api.getState);
const saved = openCache<AppState>(document.documentElement.dataset.user);
if (saved?.calendar) restoreRange(saved.calendar.key, saved.calendar.items);

const root = createRoot(document.getElementById("root")!);
const show = (state: AppState) =>
    root.render(
        <StrictMode>
            <App initial={state} latest={fresh} />
        </StrictMode>,
    );

const firstView = Promise.resolve(preloadView(location.pathname)).catch(() => {});

if (saved) firstView.then(() => show(saved.state));
else
    Promise.all([fresh, firstView])
        .then(([state]) => state && show(state))
        .catch((e: Error) =>
            root.render(
                <div className="fatal">
                    <h1>{navigator.onLine ? "Couldn’t load" : "You’re offline"}</h1>
                    <p>{e.message}</p>
                </div>,
            ),
        );

// Production only: in dev it would cache Vite's unhashed modules and serve stale code.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {}); // the app works without it
    });
}
