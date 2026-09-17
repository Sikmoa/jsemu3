# 3DS / PSP Emulator

A minimal, self-contained web page that runs Nintendo 3DS and PSP games in
the browser. It's built on [EmulatorJS](https://emulatorjs.org) with two
cores: **azahar** (3DS) and **ppsspp** (PSP).

## Running it

You must serve this folder over HTTP with a server that sends
cross-origin-isolation headers — the 3DS/PSP cores are multi-threaded WASM
and simply won't load without them. A plain `python -m http.server` or
double-clicking `index.html` will **not** work.

A ready-made server is included and needs only Node.js (no npm install):

```
node server.js
```

Then open the printed address (default `http://localhost:8080`) in
Chrome, Firefox, Edge, or Safari 15.2+ (macOS or iOS — Chrome/Firefox/Edge
on iOS all use Safari's engine under the hood, so treat them the same as
Safari there for compatibility purposes).

**Opening it on a phone from another computer's `server.js`:** cross-origin
isolation (required for the threaded WASM cores) needs a secure context,
and plain `http://` over your local network doesn't count as one — only
`https://` or `http://localhost` do. Visiting `http://<your-computer's-LAN-IP>:8080`
from a phone will fail this even though it works fine on the computer
itself. Put a TLS-terminating tunnel in front of it (e.g. `ngrok http 8080`,
Tailscale Funnel, Cloudflare Tunnel) if you want to test on a real phone
over the network. The page will tell you plainly if isolation isn't active
instead of just hanging.

**Add to Home Screen:** on iOS, adding the page to your home screen (Share
→ Add to Home Screen) launches it full-screen with no Safari address bar,
and — because that storage is no longer subject to Safari's normal
"unused site data" eviction — makes save data noticeably more durable
between visits. A `manifest.json` is included so Android/Chrome offers the
same "Add to Home Screen" option.

## Hosting on GitHub Pages (or any other static host)

`server.js` is the easy path locally, but it's a Node process, and GitHub
Pages only serves static files with no way to set custom response headers
-- so without help, the cross-origin-isolation requirement above can't be
met there at all, and the page would just show the "isn't cross-origin
isolated" message forever.

`coi-serviceworker.js` (registered by `coi.js`, wired in at the very top
of `index.html`) works around that: it's a service worker that adds the
required headers to every response itself, including the page's own HTML.
The only cost is a single automatic reload the very first time the page
is opened on a given browser/device -- a service worker can't add headers
to the request that installs it, only to requests after it's active, so
one reload is unavoidable to get from "installed" to "in control." Every
visit after that is instant, with no reload, since the worker is already
active.

This is a complete no-op when you run the page via `server.js` -- it
checks `crossOriginIsolated` first and does nothing at all if the headers
are already present, so the two approaches don't conflict.

To publish this folder itself: push it to a repo and enable Pages for it
(Settings → Pages → Deploy from a branch), pointing at whichever branch
and folder hold `index.html`.

## Using it

Drop a game file onto the page, or click it to browse for one. It figures
out on its own whether the file is a 3DS or PSP game (by extension, then
by the file's own header bytes if the extension is missing or unusual).
If it genuinely can't tell — which mainly happens with raw `.elf` files,
since both systems can run those — it'll ask you to pick once.

**3DS commercial games**: many require your own console's decryption keys
(`aes_keys.txt`) or firmware dumps (`boot9.bin`/`boot11.bin`) to run —
these have to come from a 3DS you own; there's no way around that and
nothing here can supply them. If you have one, drop it onto the page
*before* the game file and it'll be picked up automatically as a
key/firmware file rather than a game.

**PSP games** generally don't need anything extra.

## Virtual SD card (3DS)

Some 3DS games — Persona Q is a well-known example — check the SD card for
free space or use it for extra save/extra data, and won't boot properly
without one. Every 3DS launch now turns the Azahar core's virtual SD card on
by default (it's stored alongside your save data in the browser, via
IndexedDB, so it persists between visits).

If a game still won't run right — e.g. it was launched once before this was
fixed and its SD card ended up in a bad state — click **Create Virtual SD
Card**, pick that game, and it'll boot with a completely fresh, empty SD
card instead of resuming its previous state.

There's only ever one virtual SD card per browser, shared by every 3DS game
you run here — same as a real 3DS, where the SD card is one physical thing
shared by the whole console, not something each game gets its own copy of.

Once a 3DS game is running, a small **SD Card** button appears in the
top-right corner of the screen. It opens a menu showing what's actually on
the card right now — every file and folder, plus total size used — with a
**Reset SD Card** button alongside it that does the same wipe-and-reboot in
place, no need to leave the page or drop the file again. Either way,
resetting clears this session's autosave first, since the reboot starts the
game fresh.

## Automatic retry on stuck loads

Older EmulatorJS builds (this one is 4.2.4) have a known issue, specific to
Chrome/Chromium, where the 3DS/PSP cores occasionally wedge partway through
loading — the loading screen just sits there forever, with no error. It's a
race in the WASM/thread bootstrap, not anything wrong with the ROM, and the
usual manual fix is refreshing the page a couple of times.

This page now does that automatically: if a launch doesn't finish starting
within 45 seconds (75 on mobile — these cores are generally slower to
compile on phones, and a flat desktop-tuned timeout was firing false
retries there), or the engine reports a start error, it's torn down and
retried with the same file — up to 3 times — before showing a "still hasn't
loaded" screen with a manual retry button and a plain page-reload fallback.

The retry logic kicks in on Chrome and on Safari/WebKit (macOS and iOS —
Safari shows this same class of symptom, not just Chrome) by default, but
not Firefox or other browsers, since they haven't shown this bug; see the
`RETRY_ON_CHROME`, `RETRY_ON_SAFARI`, `MAX_LOAD_RETRIES`, and
`LOAD_TIMEOUT_MS` constants near the top of `app.js` if you want to change
that.

## Saving progress

There's no save-state menu to think about. Progress is auto-saved
periodically (every ~20s) and whenever you switch tabs or close the page,
and is automatically resumed the next time you load the same file. Saves
are kept in the browser's local storage (IndexedDB), tied to the file's
name and size — so a save only carries over if you reopen the same file
in the same browser. IndexedDB can be unavailable in Safari Private
Browsing (or when device storage is restricted); the game still runs, it
just can't save, and a one-time on-screen notice says so instead of the
save just silently not being there next time.

## What's in here

This is a trimmed-down copy of EmulatorJS 4.2.4 (GPL-3.0) — the ~50
other emulator cores it normally ships with have been removed, keeping
just the 3DS and PSP ones. `index.html` / `app.js` are a custom, minimal
front end replacing the original demo UI; `data/` is the EmulatorJS
engine itself, unmodified. `manifest.json` and `icons/` support
"Add to Home Screen" on Android/Chrome and iOS/Safari (see above).

`coi-serviceworker.js` and `coi.js` are the one exception to "no service
worker" -- added specifically, and only, to make static hosts like GitHub
Pages viable (see above). It does one job -- add three headers to
responses that already happened -- and gets out of the way entirely
(via its own `crossOriginIsolated` check) the moment real headers are
present, so it can't strip or interfere with anything `server.js` sets.
