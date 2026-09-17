/*
 * Adds the Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy /
 * Cross-Origin-Resource-Policy headers this page needs (for
 * SharedArrayBuffer / the threaded WASM cores) to every response it
 * serves, including the page's own HTML.
 *
 * This exists for static hosts -- GitHub Pages chief among them -- that
 * give you no way to set custom response headers yourself. server.js
 * already sets these headers directly when you run it locally, so this
 * file only matters on hosts that can't.
 *
 * It only ever adds headers to a response that already happened; it
 * never changes what's fetched, blocks anything, or caches anything.
 */

const COOP = "same-origin";
const COEP = "require-corp";
const CORP = "cross-origin";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Opaque / opaque-redirect responses (cross-origin, no-cors)
                // can't have their headers read or replaced -- pass them
                // through untouched rather than breaking them.
                if (response.status === 0 || response.type === "opaque" || response.type === "opaqueredirect") {
                    return response;
                }
                const headers = new Headers(response.headers);
                headers.set("Cross-Origin-Opener-Policy", COOP);
                headers.set("Cross-Origin-Embedder-Policy", COEP);
                headers.set("Cross-Origin-Resource-Policy", CORP);
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            })
            .catch(() => fetch(event.request))
    );
});
