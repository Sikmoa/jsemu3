/* ------------------------------------------------------------------------
   3DS / PSP web emulator — glue code
   - Detects whether a dropped file is a 3DS or PSP game (extension first,
     then a peek at the file's magic bytes, then a last-resort chooser).
   - Launches EmulatorJS (data/loader.js) with the right core.
   - Auto-saves progress to IndexedDB and auto-resumes it next time the
     same file is loaded, with no manual "save slot" management needed.
   - Watches each launch for the Chrome-specific "wedges while loading"
     bug in this EmulatorJS build and automatically retries it.
   - Lets you create or reset the 3DS virtual SD card at any time, including
     mid-emulation, not just before a game is launched -- offering a plain
     "Create" action when no card exists yet, and a separate, confirm-gated
     "Reset" action once one actually holds data worth warning about.
   ------------------------------------------------------------------------ */

(() => {
    "use strict";

    // ---- extension tables -------------------------------------------------
    const EXT_3DS = ["3ds", "cci", "cxi", "cia", "3dsx", "app"];
    const EXT_PSP = ["iso", "cso", "pbp", "prx"];
    const EXT_AMBIGUOUS = ["elf", "axf"]; // both cores can run raw ELF homebrew
    const EXT_BIOS_HINT = ["bin", "txt", "db"]; // aes_keys.txt, boot9.bin, boot11.bin, seeddb.bin...

    function extOf(name) {
        const parts = name.toLowerCase().split(".");
        return parts.length > 1 ? parts.pop() : "";
    }

    // ---- magic-byte sniffing ----------------------------------------------
    async function readBytes(file, start, length) {
        const blob = file.slice(start, start + length);
        const buf = await blob.arrayBuffer();
        return new Uint8Array(buf);
    }

    function bytesEqualAscii(bytes, offset, str) {
        for (let i = 0; i < str.length; i++) {
            if (bytes[offset + i] !== str.charCodeAt(i)) return false;
        }
        return true;
    }

    async function sniffSystem(file) {
        try {
            // NCSD (.3ds/.cci) and NCCH (.cxi/.app) headers carry their magic
            // at offset 0x100.
            const head = await readBytes(file, 0, 0x110);
            if (bytesEqualAscii(head, 0x100, "NCSD") || bytesEqualAscii(head, 0x100, "NCCH")) {
                return "3ds";
            }
            if (bytesEqualAscii(head, 0, "CISO")) return "psp"; // .cso
            if (bytesEqualAscii(head, 0, "\0PBP")) return "psp"; // .pbp / EBOOT
            // Generic ISO9660 volume descriptor (UMD dumps).
            const isoHead = await readBytes(file, 0x8001, 5);
            if (bytesEqualAscii(isoHead, 0, "CD001")) return "psp";
        } catch (e) {
            console.warn("Header sniff failed:", e);
        }
        return null;
    }

    // Peek at a .zip's local file headers (without decompressing) to see
    // if it contains a recognizable ROM inside.
    async function sniffZip(file) {
        try {
            const bytes = await readBytes(file, 0, Math.min(file.size, 2 * 1024 * 1024));
            const view = new DataView(bytes.buffer);
            for (let i = 0; i + 30 < bytes.length; i++) {
                if (view.getUint32(i, true) !== 0x04034b50) continue; // local file header sig
                const nameLen = view.getUint16(i + 26, true);
                const extraLen = view.getUint16(i + 28, true);
                const nameBytes = bytes.slice(i + 30, i + 30 + nameLen);
                const name = new TextDecoder().decode(nameBytes);
                const ext = extOf(name);
                if (EXT_3DS.includes(ext)) return { system: "3ds", innerName: name };
                if (EXT_PSP.includes(ext)) return { system: "psp", innerName: name };
                i += 30 + nameLen + extraLen - 1;
            }
        } catch (e) {
            console.warn("Zip sniff failed:", e);
        }
        return null;
    }

    function looksLikeBiosFile(file) {
        const ext = extOf(file.name);
        const lname = file.name.toLowerCase();
        if (!EXT_BIOS_HINT.includes(ext)) return false;
        if (file.size > 32 * 1024 * 1024) return false;
        return true;
    }

    /**
     * Figures out what kind of file was given.
     * @returns {Promise<{kind:"3ds"|"psp"|"bios"|"unknown"}>}
     */
    async function classifyFile(file) {
        const ext = extOf(file.name);

        if (EXT_3DS.includes(ext)) return { kind: "3ds" };
        if (EXT_PSP.includes(ext)) return { kind: "psp" };

        if (ext === "zip") {
            const found = await sniffZip(file);
            if (found) return { kind: found.system };
        }

        if (!EXT_AMBIGUOUS.includes(ext)) {
            const sniffed = await sniffSystem(file);
            if (sniffed) return { kind: sniffed };
        } else {
            const sniffed = await sniffSystem(file);
            if (sniffed) return { kind: sniffed };
        }

        if (looksLikeBiosFile(file)) return { kind: "bios" };

        return { kind: "unknown" };
    }

    // ---- tiny IndexedDB-backed autosave store ------------------------------
    const DB_NAME = "ejs-autocontinue";
    const STORE = "saves";

    function openDb() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveProgress(key, data) {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).put({ data, savedAt: Date.now() }, key);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn("Autosave failed:", e);
            warnStorageUnavailable();
        }
    }

    async function loadProgress(key) {
        try {
            const db = await openDb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, "readonly");
                const req = tx.objectStore(STORE).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn("Reading saved progress failed:", e);
            warnStorageUnavailable();
            return null;
        }
    }

    // ---- virtual SD card (3DS) helpers -------------------------------------
    //
    // Azahar (the 3DS core) exposes its SD card as a libretro core option,
    // "citra_use_virtual_sd" -- see EmulatorJS/libretro core docs. A number
    // of commercial titles (Persona Q is a well-known example) check the SD
    // card for free space or rely on it for extra save/extra data, and will
    // fail to boot, hang, or misbehave if it isn't enabled. The previous
    // version of this page never set this option at all, so behavior
    // depended entirely on whatever the compiled core defaults to -- that's
    // the "SD cards are broken" bug.
    //
    // The core keeps that SD card as a folder named "sdmc" underneath the
    // save directory we hand RetroArch (savefile_directory = "/data/saves",
    // see data/emulator.min.js), which is itself persisted via IndexedDB
    // (IDBFS with autoPersist), so once created it should survive reloads.
    // We don't hardcode the exact nesting under /data/saves in case it
    // differs between core builds -- instead we search a few levels down for
    // a directory literally called "sdmc".
    //
    // Note there's only ever one virtual SD card per browser, shared across
    // every 3DS game you run here -- same as a real 3DS, where the SD card
    // is a single physical thing shared by the whole console, not something
    // each game gets its own copy of.
    function findSdCardDir(fs) {
        let found = null;

        function search(dir, depth) {
            if (depth > 5 || found) return;
            let entries;
            try {
                entries = fs.readdir(dir);
            } catch (e) {
                return;
            }
            for (const name of entries) {
                if (name === "." || name === "..") continue;
                const full = `${dir}/${name}`;
                let stat;
                try {
                    stat = fs.stat(full);
                } catch (e) {
                    continue;
                }
                if (!fs.isDir(stat.mode)) continue;
                if (name.toLowerCase() === "sdmc") {
                    found = full;
                    return;
                }
                search(full, depth + 1);
            }
        }

        search("/data/saves", 0);
        return found;
    }

    function removeTree(fs, path) {
        let entries;
        try {
            entries = fs.readdir(path);
        } catch (e) {
            return;
        }
        for (const name of entries) {
            if (name === "." || name === "..") continue;
            const full = `${path}/${name}`;
            let stat;
            try {
                stat = fs.stat(full);
            } catch (e) {
                continue;
            }
            if (fs.isDir(stat.mode)) {
                removeTree(fs, full);
                try { fs.rmdir(full); } catch (e) { /* ignore */ }
            } else {
                try { fs.unlink(full); } catch (e) { /* ignore */ }
            }
        }
    }

    function wipeVirtualSdCard(gameManager) {
        const fs = gameManager && gameManager.FS;
        if (!fs) return false;
        const sdRoot = findSdCardDir(fs);
        if (!sdRoot) return false;
        removeTree(fs, sdRoot);
        return true;
    }

    // Walks the live SD card and returns a listing for the "SD Card" menu:
    // every file/folder underneath it (paths relative to the card's root),
    // plus a running total size and counts for the summary line.
    function listVirtualSdCard(gameManager) {
        const fs = gameManager && gameManager.FS;
        const result = { found: false, entries: [], totalSize: 0, fileCount: 0, dirCount: 0 };
        if (!fs) return result;

        const sdRoot = findSdCardDir(fs);
        if (!sdRoot) return result;
        result.found = true;

        function walk(path, relPath) {
            let entries;
            try {
                entries = fs.readdir(path);
            } catch (e) {
                return;
            }
            entries
                .filter((name) => name !== "." && name !== "..")
                .sort()
                .forEach((name) => {
                    const full = `${path}/${name}`;
                    const rel = relPath ? `${relPath}/${name}` : name;
                    let stat;
                    try {
                        stat = fs.stat(full);
                    } catch (e) {
                        return;
                    }
                    if (fs.isDir(stat.mode)) {
                        result.dirCount++;
                        result.entries.push({ path: rel, isDir: true, size: 0 });
                        walk(full, rel);
                    } else {
                        const size = stat.size || 0;
                        result.fileCount++;
                        result.totalSize += size;
                        result.entries.push({ path: rel, isDir: false, size });
                    }
                });
        }

        walk(sdRoot, "");
        return result;
    }

    function formatBytes(n) {
        if (n < 1024) return `${n} B`;
        const units = ["KB", "MB", "GB", "TB"];
        let val = n / 1024;
        let i = 0;
        while (val >= 1024 && i < units.length - 1) {
            val /= 1024;
            i++;
        }
        return `${val.toFixed(val < 10 ? 2 : 1)} ${units[i]}`;
    }

    // Wipe the virtual SD card (if one exists) and reboot the core so it
    // rebuilds one from scratch. Shared by the pre-launch "Create Virtual
    // SD Card" button, the mid-emulation menu's "Create SD Card" action
    // (nothing to wipe yet, so this just provisions a fresh one), and its
    // "Reset SD Card" action (wipes an existing card first) -- same
    // underlying operation either way, just triggered at different points
    // and with different framing depending on whether a card already exists.
    async function resetVirtualSdCard(gameKey, emu) {
        emu = emu || window.EJS_emulator;
        const gm = emu && emu.gameManager;
        if (!gm) return false;
        const found = wipeVirtualSdCard(gm);
        await clearProgress(gameKey);
        if (gm.restart) gm.restart();
        if (emu.displayMessage) {
            emu.displayMessage(found ? "Old virtual SD card cleared — starting fresh" : "Virtual SD card created");
        }
        try { localStorage.setItem("ejs_3ds_sdcard_created", "1"); } catch (e) { /* ignore */ }
        return true;
    }

    // The "SD Card" menu -- shows what's actually on the live virtual SD
    // card right now (files, folders, sizes) with a reset action alongside
    // it, so you don't have to trust that it's "probably fine" blindly.
    function showSdCardMenu(state) {
        const emu = window.EJS_emulator;
        const gm = emu && emu.gameManager;
        const info = listVirtualSdCard(gm);

        const backdrop = document.createElement("div");
        backdrop.id = "sdcardMenuBackdrop";
        Object.assign(backdrop.style, {
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
        });
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) backdrop.remove();
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            background: "#1a1a1a",
            border: "1px solid #444",
            borderRadius: "0.5em",
            padding: "1.25em",
            width: "26em",
            maxWidth: "90vw",
            maxHeight: "80vh",
            display: "flex",
            flexDirection: "column",
            gap: "0.75em",
            color: "#ddd",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
        });

        const title = document.createElement("div");
        title.textContent = "Virtual SD Card";
        title.style.fontSize = "1.1em";
        title.style.fontWeight = "bold";

        const summary = document.createElement("div");
        summary.style.fontSize = "0.85em";
        summary.style.color = "#999";
        summary.textContent = info.found
            ? `${info.fileCount} file${info.fileCount === 1 ? "" : "s"}, ` +
              `${info.dirCount} folder${info.dirCount === 1 ? "" : "s"} — ${formatBytes(info.totalSize)} used`
            : "No virtual SD card contents yet for this session.";

        const list = document.createElement("div");
        Object.assign(list.style, {
            overflowY: "auto",
            flex: "1",
            border: "1px solid #333",
            borderRadius: "0.3em",
            padding: "0.5em",
            fontSize: "0.8em",
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            minHeight: "3em",
        });
        if (info.entries.length) {
            info.entries.forEach((entry) => {
                const row = document.createElement("div");
                Object.assign(row.style, {
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "1em",
                    padding: "0.15em 0",
                });
                const name = document.createElement("span");
                name.textContent = (entry.isDir ? "📁 " : "📄 ") + entry.path;
                Object.assign(name.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
                const size = document.createElement("span");
                size.style.color = "#888";
                size.style.flexShrink = "0";
                size.textContent = entry.isDir ? "" : formatBytes(entry.size);
                row.appendChild(name);
                row.appendChild(size);
                list.appendChild(row);
            });
        } else {
            list.textContent = info.found ? "(empty)" : "Nothing to show yet.";
            list.style.color = "#666";
        }

        const btnRow = document.createElement("div");
        btnRow.style.display = "flex";
        btnRow.style.justifyContent = "space-between";
        btnRow.style.gap = "0.5em";

        const leftBtns = document.createElement("div");
        leftBtns.style.display = "flex";
        leftBtns.style.gap = "0.5em";

        const refreshBtn = document.createElement("button");
        refreshBtn.textContent = "Refresh";
        refreshBtn.onclick = () => {
            backdrop.remove();
            showSdCardMenu(state);
        };

        // Two distinct actions instead of one overloaded "reset" button:
        //  - card has no actual contents yet -> "Create SD Card", a plain,
        //    non-destructive action with no erase warning, since there's
        //    nothing on the card to lose yet. Note this is NOT the same as
        //    info.found: the core creates an empty "sdmc" folder the moment
        //    a 3DS game boots (the virtual SD option is forced on for every
        //    launch), so info.found is true well before there's anything
        //    worth warning about. We only want the scary button once the
        //    card actually holds files/folders.
        //  - card already has files/folders on it -> "Reset SD Card", which
        //    stays destructive and keeps the confirm() prompt, since this
        //    one actually erases whatever the game has already stored.
        // Both are backed by the same resetVirtualSdCard() helper -- wiping
        // a card that has nothing on it is a no-op, so "create" just
        // reboots the core with the virtual SD option on and lets it lay
        // down a fresh, empty card (or leaves the existing empty one be).
        const hasContent = info.found && (info.fileCount > 0 || info.dirCount > 0);
        const actionBtn = document.createElement("button");

        if (hasContent) {
            actionBtn.textContent = "Reset SD Card";
            actionBtn.style.borderColor = "#a44";
            actionBtn.onclick = async () => {
                const ok = confirm(
                    "This reboots the game with a completely fresh virtual SD card. " +
                    "Any extra SD-stored save data for this session will be cleared. Continue?"
                );
                if (!ok) return;
                actionBtn.disabled = true;
                actionBtn.textContent = "Resetting…";
                try {
                    await resetVirtualSdCard(state.gameKey);
                    backdrop.remove();
                } catch (e) {
                    console.warn("Could not reset virtual SD card:", e);
                    actionBtn.disabled = false;
                    actionBtn.textContent = "Reset SD Card";
                }
            };
        } else {
            actionBtn.textContent = "Create SD Card";
            actionBtn.style.borderColor = "#4a8";
            actionBtn.onclick = async () => {
                actionBtn.disabled = true;
                actionBtn.textContent = "Creating…";
                try {
                    await resetVirtualSdCard(state.gameKey);
                    backdrop.remove();
                } catch (e) {
                    console.warn("Could not create virtual SD card:", e);
                    actionBtn.disabled = false;
                    actionBtn.textContent = "Create SD Card";
                }
            };
        }

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "Close";
        closeBtn.onclick = () => backdrop.remove();

        [refreshBtn, actionBtn, closeBtn].forEach((b) => {
            Object.assign(b.style, {
                padding: "0.4em 0.9em",
                fontSize: "0.85em",
                borderRadius: "0.4em",
                border: "1px solid #555",
                background: "#2a2a2a",
                color: "#ddd",
                cursor: "pointer",
            });
        });

        leftBtns.appendChild(refreshBtn);
        leftBtns.appendChild(actionBtn);
        btnRow.appendChild(leftBtns);
        btnRow.appendChild(closeBtn);

        panel.appendChild(title);
        panel.appendChild(summary);
        panel.appendChild(list);
        panel.appendChild(btnRow);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
    }

    // Small always-on-top button, injected once a 3DS game actually starts,
    // that opens the SD Card menu above.
    function injectMidGameSdButton(state) {
        if (state.system !== "3ds") return;
        if (document.getElementById("midSdcardBtn")) return;

        const btn = document.createElement("button");
        btn.id = "midSdcardBtn";
        btn.type = "button";
        btn.textContent = "SD Card";
        Object.assign(btn.style, {
            position: "fixed",
            top: "0.5em",
            right: "0.5em",
            zIndex: 9999,
            padding: "0.4em 0.8em",
            fontSize: "0.8em",
            borderRadius: "0.4em",
            border: "1px solid #555",
            background: "rgba(42,42,42,0.85)",
            color: "#ddd",
            cursor: "pointer",
        });
        btn.addEventListener("click", () => showSdCardMenu(state));
        document.body.appendChild(btn);
    }

    // ---- Chrome load-retry workaround ---------------------------------------
    //
    // Older EmulatorJS builds (this bundle is 4.2.4) have a known bug, seen
    // specifically on Chrome/Chromium, where the WASM/pthread bootstrap for
    // the 3DS and PSP cores occasionally wedges partway through loading —
    // the loading screen just sits there forever with no error, and the
    // "start" event never fires. It's a race in the worker handshake, not
    // anything wrong with the ROM. The usual manual workaround is "refresh
    // the page a couple of times", so that's what this automates: if a
    // launch doesn't reach "start" within LOAD_TIMEOUT_MS, or the engine
    // itself reports a start error, tear the instance down and try again
    // with the same file, up to MAX_LOAD_RETRIES times.
    //
    // This only recreates the EmulatorJS instance in-page (not a real page
    // reload), so it works cheaply even for large ROMs — the File object is
    // reused as-is rather than re-read into memory. If that's not enough to
    // clear a wedged attempt, the failure screen offers a real page reload
    // as a fallback, since that's the more thorough (but heavier) fix.
    // Retry the stuck-load watchdog on Chrome (the originally-reported
    // browser) AND on Safari/WebKit, which shows the same class of
    // symptom -- loading screen sits there forever, no error -- on both
    // macOS and iOS with these threaded WASM cores. Left off for Firefox
    // and anything else we can't positively identify, since retrying a
    // launch that was never going to get stuck just wastes time.
    const RETRY_ON_CHROME = true;
    const RETRY_ON_SAFARI = true;
    const MAX_LOAD_RETRIES = 3;

    // Mobile devices (phones especially) commonly take longer to compile
    // and instantiate these multi-MB threaded WASM cores than a desktop --
    // fewer/slower cores, more thermal throttling, sometimes a cold cache.
    // A flat 45s timeout tuned on desktop was firing retries on phones that
    // were simply still working, not stuck -- so give mobile more rope
    // before treating a slow load as a wedged one.
    const LOAD_TIMEOUT_MS = isProbablyMobile() ? 75000 : 45000;

    function isProbablyChrome() {
        const ua = navigator.userAgent;
        if (!/Chrome\//.test(ua)) return false;
        // Other Chromium browsers carry "Chrome/" in their UA too, but
        // haven't been reported to hit this bug -- don't retry for them.
        if (/Edg\//.test(ua)) return false; // Edge
        if (/OPR\//.test(ua)) return false; // Opera
        if (/SamsungBrowser\//.test(ua)) return false;
        if (navigator.brave) return false; // Brave exposes this API
        return true;
    }

    // iPadOS 13+ deliberately reports as a Mac (desktop-class UA) to get
    // desktop sites, so UA sniffing alone can't tell an iPad from a Mac --
    // touch support is what actually distinguishes them.
    function isIOS() {
        const ua = navigator.userAgent;
        if (/iP(hone|od|ad)/.test(ua)) return true;
        return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    }

    // Every browser on iOS is required to use WebKit under the hood
    // (Chrome/Firefox/Edge for iOS are all just Safari wearing a skin), so
    // "on iOS" and "on Safari's engine" are effectively the same condition
    // there. On desktop we still need to exclude the other browsers whose
    // UA strings happen to contain "Safari" too.
    function isProbablySafari() {
        if (isIOS()) return true;
        const ua = navigator.userAgent;
        if (!/Safari\//.test(ua)) return false;
        if (/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua)) return false;
        if (navigator.brave) return false;
        return true;
    }

    function isProbablyMobile() {
        return isIOS() || /Android|Mobile/.test(navigator.userAgent);
    }

    function retryEnabled() {
        // No amount of retrying fixes missing cross-origin-isolation headers.
        if (window.crossOriginIsolated !== true) return false;
        if (isProbablyChrome()) return RETRY_ON_CHROME;
        if (isProbablySafari()) return RETRY_ON_SAFARI;
        return false;
    }

    function clearLoadWatchdog(state) {
        if (state.loadTimeoutId) clearTimeout(state.loadTimeoutId);
        if (state.failPollId) clearInterval(state.failPollId);
        if (state.onWindowError) window.removeEventListener("error", state.onWindowError);
        if (state.onRejection) window.removeEventListener("unhandledrejection", state.onRejection);
        state.loadTimeoutId = null;
        state.failPollId = null;
        state.onWindowError = null;
        state.onRejection = null;
    }

    function failLoad(state, reason) {
        if (state.settled) return; // already succeeded or already handled
        state.settled = true;
        clearLoadWatchdog(state);

        if (retryEnabled() && state.attempt < MAX_LOAD_RETRIES) {
            state.attempt++;
            console.warn(`Load attempt failed (${reason}) — retrying, attempt ${state.attempt} of ${MAX_LOAD_RETRIES}`);
            window.EJS_emulator = null;
            // Small pause to give the previous attempt's workers/WASM
            // memory a chance to start getting garbage-collected.
            setTimeout(() => attemptLaunch(state), 800);
        } else {
            showLoadFailurePanel(state, reason);
        }
    }

    function showLoadFailurePanel(state, reason) {
        document.body.innerHTML = "";
        const wrap = document.createElement("div");
        Object.assign(wrap.style, {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1em",
            height: "100%",
            color: "#ccc",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
            textAlign: "center",
            padding: "2em",
        });

        const msg = document.createElement("div");
        msg.textContent = retryEnabled()
            ? `"${state.file.name}" still hasn't loaded after ${MAX_LOAD_RETRIES} automatic retries (${reason}).`
            : `"${state.file.name}" didn't load (${reason}).`;

        const hint = document.createElement("div");
        hint.style.fontSize = "0.85em";
        hint.style.color = "#999";
        if (isProbablyChrome()) {
            hint.textContent = "This looks like a known Chrome loading bug in this EmulatorJS build. Firefox tends to load these cores more reliably.";
        } else if (isProbablySafari()) {
            hint.textContent = isIOS()
                ? "Safari on iOS can be inconsistent loading these cores. If this keeps happening, try Chrome or Firefox on iOS (they still use Safari's engine, so it may not help) or a desktop browser."
                : "Safari can be inconsistent loading these cores. Firefox or Chrome tend to load them more reliably.";
        } else {
            hint.textContent = "You can try again, or reload the page for a clean start.";
        }

        const btnRow = document.createElement("div");
        btnRow.style.display = "flex";
        btnRow.style.gap = "0.75em";

        const retryBtn = document.createElement("button");
        retryBtn.textContent = "Try Again";
        retryBtn.onclick = () => {
            state.attempt = 0;
            state.settled = false;
            attemptLaunch(state);
        };

        const reloadBtn = document.createElement("button");
        reloadBtn.textContent = "Reload Page";
        reloadBtn.onclick = () => location.reload();

        [retryBtn, reloadBtn].forEach((b) => {
            Object.assign(b.style, {
                padding: "0.6em 1.2em",
                fontSize: "1em",
                borderRadius: "0.4em",
                border: "1px solid #555",
                background: "#2a2a2a",
                color: "#ddd",
                cursor: "pointer",
            });
        });

        btnRow.appendChild(retryBtn);
        btnRow.appendChild(reloadBtn);
        wrap.appendChild(msg);
        wrap.appendChild(hint);
        wrap.appendChild(btnRow);
        document.body.appendChild(wrap);
    }

    async function clearProgress(key) {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).delete(key);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn("Clearing saved progress failed:", e);
            warnStorageUnavailable();
        }
    }

    // ---- UI -----------------------------------------------------------------
    const dropZone = document.getElementById("dropzone");
    const status = document.getElementById("status");
    const fileInput = document.getElementById("fileInput");
    const sdcardBtn = document.getElementById("sdcardBtn");
    const sdcardStatus = document.getElementById("sdcardStatus");

    let pendingBios = null; // File object, if a key/firmware file was dropped first
    let wantsFreshSd = false; // set when launch was triggered via the SD-card button

    function setStatus(text) {
        status.textContent = text || "";
    }

    try {
        if (sdcardStatus && localStorage.getItem("ejs_3ds_sdcard_created")) {
            sdcardStatus.textContent = "A virtual SD card has already been created in this browser.";
        }
    } catch (e) {
        // localStorage unavailable (private browsing etc.) -- not fatal
    }

    async function handleFile(file, resetSd = false) {
        setStatus("Checking file…");
        const { kind } = await classifyFile(file);

        if (kind === "bios") {
            pendingBios = file;
            setStatus(`Loaded "${file.name}" as a key/firmware file. Now drop your game.`);
            return;
        }

        if (kind === "3ds" || kind === "psp") {
            if (resetSd && kind !== "3ds" && sdcardStatus) {
                sdcardStatus.textContent = "The virtual SD card only applies to 3DS games — launching normally.";
            }
            launch(file, kind, pendingBios, resetSd && kind === "3ds");
            return;
        }

        showChooser(file, resetSd);
    }

    function showChooser(file, resetSd) {
        dropZone.innerHTML = "";
        const msg = document.createElement("div");
        msg.className = "msg";
        msg.textContent = `Couldn't tell what "${file.name}" is. Pick one:`;
        const btn3ds = document.createElement("button");
        btn3ds.textContent = "It's a 3DS game";
        btn3ds.onclick = () => launch(file, "3ds", pendingBios, !!resetSd);
        const btnPsp = document.createElement("button");
        btnPsp.textContent = "It's a PSP game";
        btnPsp.onclick = () => launch(file, "psp", pendingBios, false);
        dropZone.appendChild(msg);
        dropZone.appendChild(btn3ds);
        dropZone.appendChild(btnPsp);
    }

    function launch(file, system, bios, resetSd) {
        const state = {
            file,
            system,
            bios,
            resetSd,
            gameKey: `${system}:${file.name}:${file.size}`,
            attempt: 0, // bumped by failLoad() on each automatic retry
            settled: false, // true once this attempt has succeeded or failed
            loadTimeoutId: null,
            failPollId: null,
            onWindowError: null,
            onRejection: null,
        };
        attemptLaunch(state);
    }

    function attemptLaunch(state) {
        const { file, system, bios, resetSd, gameKey } = state;
        state.settled = false;

        document.body.innerHTML = "";
        const container = document.createElement("div");
        container.id = "display";
        const game = document.createElement("div");
        game.id = "game";
        container.appendChild(game);
        document.body.appendChild(container);
        if (state.attempt > 0) {
            const notice = document.createElement("div");
            notice.textContent = `Retrying load — attempt ${state.attempt} of ${MAX_LOAD_RETRIES}…`;
            Object.assign(notice.style, {
                position: "fixed", top: "0.5em", left: "0.5em", zIndex: 9999,
                fontSize: "0.8em", color: "#999",
            });
            document.body.appendChild(notice);
        }

        window.EJS_player = "#game";
        window.EJS_gameName = file.name.replace(/\.[^.]+$/, "");
        window.EJS_gameID = gameKey;
        window.EJS_gameUrl = file;
        window.EJS_core = system === "3ds" ? "3ds" : "psp";
        window.EJS_pathtodata = "data/";
        window.EJS_threads = true;
        window.EJS_startOnLoaded = true;
        window.EJS_askBeforeExit = false;
        if (bios) window.EJS_biosUrl = bios;

        if (state.attempt > 0) {
            // A dynamic import() of the same URL is cached by the browser
            // and won't actually re-run -- so a wedged internal state from
            // the failed attempt would just get handed straight back to us.
            // Busting the URL forces a genuinely fresh module evaluation,
            // which is what makes this retry meaningfully different from
            // just calling attemptLaunch() again.
            window.EJS_paths = Object.assign({}, window.EJS_paths, {
                "emulator.min.js": `data/emulator.min.js?retry=${state.attempt}`,
            });
        } else {
            delete window.EJS_paths;
        }

        if (system === "3ds") {
            // Force the virtual SD card on for every 3DS launch -- see the
            // wipeVirtualSdCard() comment above for why.
            window.EJS_defaultOptions = Object.assign(
                {},
                window.EJS_defaultOptions,
                { citra_use_virtual_sd: "enabled" }
            );
        } else {
            delete window.EJS_defaultOptions;
        }

        let autosaveTimer = null;

        function doAutosave() {
            const emu = window.EJS_emulator;
            if (!emu || !emu.gameManager || !emu.started) return;
            try {
                const saveState = emu.gameManager.getState();
                saveProgress(gameKey, saveState);
            } catch (e) {
                console.warn("Autosave failed:", e);
            }
        }

        window.EJS_onGameStart = async () => {
            // The game actually started -- this attempt succeeded, so stop
            // watching it for the Chrome load-wedge bug.
            state.settled = true;
            clearLoadWatchdog(state);

            if (system === "3ds" && resetSd) {
                // Fresh-SD-card flow: wipe out any existing SD contents and
                // any previous auto-save for this exact file, then reboot
                // the core so it starts clean instead of resuming state that
                // assumed the old (possibly broken) SD card.
                try {
                    await resetVirtualSdCard(gameKey);
                } catch (e) {
                    console.warn("Could not reset virtual SD card:", e);
                }
            } else {
                const saved = await loadProgress(gameKey);
                if (saved && saved.data) {
                    try {
                        window.EJS_emulator.gameManager.loadState(saved.data);
                        window.EJS_emulator.displayMessage("Continuing saved game");
                    } catch (e) {
                        console.warn("Could not resume saved game:", e);
                    }
                }
            }
            autosaveTimer = setInterval(doAutosave, 20000);
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) doAutosave();
            });
            window.addEventListener("pagehide", doAutosave);

            injectMidGameSdButton(state);
        };

        window.EJS_onExit = () => {
            doAutosave();
            if (autosaveTimer) clearInterval(autosaveTimer);
            const btn = document.getElementById("midSdcardBtn");
            if (btn) btn.remove();
        };

        const script = document.createElement("script");
        script.src = "data/loader.js";
        document.body.appendChild(script);

        // ---- arm the load watchdog for this attempt ----
        if (retryEnabled()) {
            state.loadTimeoutId = setTimeout(() => failLoad(state, "timed out"), LOAD_TIMEOUT_MS);
            state.failPollId = setInterval(() => {
                if (window.EJS_emulator && window.EJS_emulator.failedToStart) {
                    failLoad(state, "engine reported a start error");
                }
            }, 500);
            state.onWindowError = () => failLoad(state, "script error while loading");
            state.onRejection = () => failLoad(state, "script error while loading");
            window.addEventListener("error", state.onWindowError);
            window.addEventListener("unhandledrejection", state.onRejection);
        }
    }

    // ---- wire up drop zone ---------------------------------------------------
    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        const resetSd = wantsFreshSd;
        wantsFreshSd = false;
        if (fileInput.files[0]) handleFile(fileInput.files[0], resetSd);
        fileInput.value = "";
    });
    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.setAttribute("drag", "true");
    });
    dropZone.addEventListener("dragleave", () => dropZone.removeAttribute("drag"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.removeAttribute("drag");
        wantsFreshSd = false;
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file, false);
    });

    // ---- wire up "Create Virtual SD Card" button -----------------------------
    if (sdcardBtn) {
        sdcardBtn.addEventListener("click", () => {
            wantsFreshSd = true;
            if (sdcardStatus) {
                sdcardStatus.textContent = "Choose your 3DS game — it'll launch with a freshly created virtual SD card.";
            }
            fileInput.click();
        });
    }

    if (window.crossOriginIsolated !== true) {
        // Checking `crossOriginIsolated` directly (rather than just
        // feature-sniffing `typeof SharedArrayBuffer`) is the correct way
        // to detect this: some browsers -- Safari in particular has had
        // versions of this -- can expose the SharedArrayBuffer constructor
        // without the tab actually being cross-origin isolated, which used
        // to let this page limp past the check and then hang silently
        // instead of showing this message.
        let msg =
            "This browser tab isn't cross-origin isolated, so the 3DS/PSP cores " +
            "can't use threads and won't load. If you're running this locally, " +
            "serve this folder with the included server.js (it sets the required " +
            "headers) and open it from that server. If this is hosted statically " +
            "(GitHub Pages, etc.), coi-serviceworker.js should have handled this " +
            "via one automatic reload -- try a manual reload, and check the " +
            "browser console for a service worker registration error if it still " +
            "doesn't clear up.";
        if (isIOS()) {
            msg += " Cross-origin isolation also needs Safari 15.2+ (any browser on " +
                "iOS, since they all use Safari's engine) and, if you're opening this " +
                "on a phone from another computer's server.js, HTTPS -- plain http:// " +
                "over your local network won't qualify unless it's localhost.";
        }
        setStatus(msg);
    }

    // Autosave/SD-card storage relies on IndexedDB. It can fail to open in
    // Safari Private Browsing (and, more rarely, when device storage is
    // full or restricted), in which case openDb() above already degrades
    // gracefully -- the game still runs, it just can't save. Surface that
    // once, since "my save vanished" is a confusing thing to notice on
    // your own days later.
    let storageWarningShown = false;
    function warnStorageUnavailable() {
        if (storageWarningShown) return;
        storageWarningShown = true;
        const msg = "Progress can't be saved in this browser session (common in " +
            "Safari Private Browsing, or when storage is restricted) -- the game " +
            "will still run, it just won't auto-resume next time.";
        if (window.EJS_emulator && window.EJS_emulator.displayMessage) {
            window.EJS_emulator.displayMessage("Auto-save unavailable this session (private browsing?)");
        } else {
            setStatus(msg);
        }
        console.warn(msg);
    }
})();
