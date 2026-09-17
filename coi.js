/*
 * Registers coi-serviceworker.js and, once it's actually in control of
 * this page, reloads a single time so the reloaded page picks up the
 * Cross-Origin-Isolation headers it adds.
 *
 * That one reload is unavoidable: a service worker can't add headers to
 * the very first request that installed it, only to requests after it's
 * active. It only ever happens once per browser/device, the first time
 * this page is opened from wherever it's hosted -- every visit after
 * that, the worker is already controlling the page and crossOriginIsolated
 * is already true, so this file does nothing at all.
 *
 * If this page is already cross-origin isolated -- e.g. served locally
 * via the included server.js, which sets the headers itself -- this is a
 * complete no-op and never registers anything.
 */
(() => {
    "use strict";

    if (window.crossOriginIsolated) return;
    if (!("serviceWorker" in navigator)) return; // app.js's own check further down explains this case

    const RELOAD_FLAG = "coiReloadAttempted";

    function reloadOnce() {
        if (sessionStorage.getItem(RELOAD_FLAG)) return;
        sessionStorage.setItem(RELOAD_FLAG, "1");
        window.location.reload();
    }

    navigator.serviceWorker.register("coi-serviceworker.js", { scope: "./" })
        .then((registration) => {
            if (window.crossOriginIsolated) return; // became true while this was resolving

            if (navigator.serviceWorker.controller) {
                // A worker from a previous visit already controls this page,
                // but isolation still isn't active -- this is the state right
                // after the very first install, before the one reload that
                // lets it start intercepting the page's own navigation too.
                reloadOnce();
                return;
            }

            const worker = registration.installing || registration.waiting || registration.active;
            if (worker) {
                worker.addEventListener("statechange", () => {
                    if (worker.state === "activated") reloadOnce();
                });
            }
        })
        .catch(() => {
            // Registration failed (unsupported browser, running from file://,
            // etc.) -- app.js's crossOriginIsolated check further down shows
            // the right message instead of this failing silently.
        });
})();
