/*
 * Zero-dependency static file server for the 3DS/PSP emulator.
 *
 * The azahar (3DS) and ppsspp (PSP) cores are multi-threaded WASM builds,
 * which means the page needs SharedArrayBuffer, which in turn means the
 * response headers below (Cross-Origin-Opener-Policy / Embedder-Policy)
 * have to be present. Most simple static servers don't set these, so a
 * plain `python -m http.server` will NOT work here — use this instead.
 *
 * Usage:
 *   node server.js [port]
 * Then open the printed URL in a browser (Chrome/Firefox/Edge; Safari's
 * support for this is inconsistent).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8080;
const ROOT = __dirname;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".data": "application/octet-stream",
    ".zip": "application/zip",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
};

// manifest.json is served with this MIME type specifically (not from the
// extension table above, since ".json" is also used for plain data files
// that should stay "application/json").
const MANIFEST_MIME = "application/manifest+json; charset=utf-8";

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404);
            res.end("Not found: " + urlPath);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = urlPath === "/manifest.json"
            ? MANIFEST_MIME
            : (MIME[ext] || "application/octet-stream");

        // data/ is a pinned, unmodified copy of the EmulatorJS engine
        // (~20MB, mostly the wasm cores) -- it never changes on its own,
        // so re-downloading it in full on every visit is pure waste,
        // especially over mobile data. Everything else (our own
        // index.html/app.js/manifest, small enough that re-fetching them
        // is free) stays no-cache so edits show up on the next reload
        // without needing a hard refresh.
        const isStaticEngineAsset = urlPath.startsWith("/data/");
        const cacheControl = isStaticEngineAsset
            ? "public, max-age=604800" // 7 days
            : "no-cache";

        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": stats.size,
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": cacheControl,
        });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Serving on http://localhost:${PORT}/`);
});
