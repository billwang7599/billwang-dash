/*
 * Service worker: makes dash installable and lets the app shell open offline.
 *
 * It never touches /api -- tasks are always live, so there is no stale data to
 * mistake for the real thing. Offline, the shell loads and says it's offline.
 *
 * Bump CACHE only when the strategy below changes; Vite's hashed asset names
 * already take care of new deploys.
 */
const CACHE = "dash-v1";
const SHELL = "/app";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);

    // Every /app route is the same document, so one cached copy stands in for all of them.
    if (req.mode === "navigate" && url.origin === location.origin && url.pathname.startsWith("/app")) {
        event.respondWith(networkFirst(event));
    } else if (url.origin === location.origin && url.pathname.startsWith("/assets/")) {
        event.respondWith(cacheFirst(event));
    } else if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
        event.respondWith(staleWhileRevalidate(event));
    }
});

/**
 * The network's answer goes through untouched -- including Cloudflare Access's
 * redirect to sign in, which must not be swapped for a cached page. Only a real
 * 200 is kept, and the cache is only used when the network can't be reached.
 */
async function networkFirst(event) {
    const req = event.request;
    const cache = await caches.open(CACHE);
    try {
        const res = await fetch(req);
        if (res.ok && res.type === "basic") event.waitUntil(cache.put(SHELL, res.clone()));
        return res;
    } catch (err) {
        const cached = await cache.match(SHELL);
        if (cached) return cached;
        throw err;
    }
}

/** Hashed file names never change content, so a cached copy is always right. */
async function cacheFirst(event) {
    const req = event.request;
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) event.waitUntil(cache.put(req, res.clone()));
    return res;
}

async function staleWhileRevalidate(event) {
    const req = event.request;
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const fresh = fetch(req).then(async (res) => {
        // The font stylesheet is fetched no-cors, so its response is opaque (status 0).
        if (res.ok || res.type === "opaque") await cache.put(req, res.clone());
        return res;
    });
    if (!cached) return fresh;
    event.waitUntil(fresh.catch(() => {})); // refresh in the background
    return cached;
}
