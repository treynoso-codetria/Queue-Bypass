# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automates opening many browser windows (Chrome, Edge, Brave, Opera, Firefox), each in a normal and an incognito/private variant, all pointed at the same URL and tiled over the screen. Target platform is Linux only — specifically Ubuntu 26.04 with GNOME (Wayland session, with XWayland available). The whole program is a single ES module script, `open-browsers.js`, built on Playwright.

## Commands

```bash
npm install                          # installs playwright
npx playwright install firefox       # Playwright's own Firefox build is required (see below)
node open-browsers.js                # 4 normal + 1 private window per browser, minimized, dumping
node open-browsers.js --chrome 3 --opera 0 --private 2 --url https://example.com
node open-browsers.js --no-hidden --no-dump-queue   # visible tiled windows, no queue-dumps/
node open-browsers.js --screen 1920x1080+0+0   # override the auto-detected tiling area
```

`--<browser> N` sets normal windows per browser (default 4, 0 skips the browser), `--private N` sets private windows per browser (default 1). `--hidden` and `--dump-queue` default to on; `parseArgs` runs with `allowNegative`, so they're turned off with `--no-hidden` / `--no-dump-queue`. The process stays alive until Ctrl+C, which triggers cleanup. There is no build step, linter, or test suite (`npm test` is the npm placeholder).

## Architecture

**Two launch paths per browser.** Every entry in the `BROWSERS` table describes both:
- *Normal windows* go through Playwright (`engine` + `launchOptions`). For Chromium browsers, one browser process is launched and each window is a separate `browser.newContext()` (isolated cookies/storage), positioned via CDP `Browser.setWindowBounds`.
- *Private windows* are not Playwright-controlled: the real browser binary is `spawn`ed detached (`command` + `privateArgs`) with `--incognito`/`--inprivate`/`--private`/`-private-window`, each with its own throwaway `--user-data-dir` under `.profiles/`, positioned with `--window-position`/`--window-size`.

**Firefox is special-cased throughout:**
- Uses Playwright's bundled Firefox (`firefox.executablePath()`) for *both* paths — the Ubuntu Snap Firefox can't be driven by Playwright and its AppArmor confinement prevents killing it on exit.
- Playwright can't resize Firefox windows, so each normal Firefox window gets its own persistent profile (`launchPersistentContext`), and window size is pre-seeded by writing `xulstore.json` (`writeFirefoxProfile`).
- Firefox runs as a native Wayland window (it crashes under XWayland on this setup), so GNOME chooses its position; it is excluded from the tiling grid and only receives the cell size.

**Window layout.** Chromium browsers are forced onto XWayland (`--ozone-platform=x11` in `CHROMIUM_ARGS`) because native Wayland windows can't be positioned. `detectScreen()` gets the primary monitor from `xrandr` and clips it to `_NET_WORKAREA` from `xprop` (so those tools must be present unless `--screen` is passed). `computeGrid()` fills cells column-by-column so each browser's normal and private windows stack together. Because Chromium refuses windows narrower than ~`CHROMIUM_MIN_WIDTH` UI units, a `--force-device-scale-factor` (`chromiumScale`) is computed to shrink the UI when cells are narrow; all Chromium bounds are converted with `toUiUnits()` (pixels / scale).

**Hidden mode (default).** Normal Chromium windows are minimized through their Playwright CDP session; private Chromium windows through their browser-level DevTools WebSocket (`setPrivateWindowState`, path from the second line of `DevToolsActivePort`). Every window gets a `show()` that restores it, called on the window that gets through the queue. All Chromium cells are the full screen (so the restored window is full size and `chromiumScale` is 1); only Firefox windows, which can't be minimized on Wayland and stay visible, share the screen via `firefoxCell`.

Note the module-level ordering: `grid`, `firefoxCell` and `chromiumScale` are top-level `const`s defined after the functions that read them, so they must be computed before any open* function is called.

**Queue watch (`watchQueue`).** Unless `--keep-all` is passed, every window is polled once a second; the first tab that goes from `QUEUE_HOST` (Queue-it waiting room) to `SITE_HOST` (Boca site) wins and every other window is closed, so only one session polls the site's WAF-protected API (it blocks IPs that poll too much, answering 418). Each window registers itself in `windows` as `{ label, show(), pages(), queuePage(), close() }`: Playwright windows read `context.pages()` and close their context; private Chromium windows are launched with `--remote-debugging-port=0`, their tabs are read from the DevTools `/json/list` endpoint (port taken from `<profile>/DevToolsActivePort`), and they're closed with `killProfile` (pkill on the exact profile path). Firefox private windows can't be watched (`pages()` returns `[]`) but are still closed.

**Queue ranking (`rankQueue`).** Every `RANK_INTERVAL_MS` (60 s), each window's `queuePage()` runs `collectQueuePage` in its Queue-it tab (Playwright `page.evaluate`, or `Runtime.evaluate` over the tab's DevTools WebSocket for private Chromium windows; `null` for Firefox private). `collectQueuePage` is serialized into the page, so it must stay self-contained; it reads visible element IDs (Boca's layout: `#MainPart_lbWhichIsIn`, `#hlLinkToQueueTicket2`), the knockout view model `window.queueViewModel.ticket` (which has wait/position/progress even when Boca's layout hides them), prequeue state (`body.before`) and the full body text. `interpretQueuePage` turns that into `{ wait, waitOver, position, progress, queueId, blocked, prequeue }`; `waitOver` marks "más de una hora" (wait is a lower bound). `printRanking` prints a styled box table (`node:util` `styleText`, `COLUMNS`) sorted by wait, then `waitOver`, then progress desc, then position; the interval drops to `RANK_INTERVAL_SOON_MS` (10 s) while the best wait is ≤ 1 min. Blocked windows and shared queue IDs are warned about, and `--keep-best`/`--max-wait` close the longest-wait windows, never the shortest, unknown or blocked ones. `--dump-queue` saves the raw `collectQueuePage` result to `queue-dumps/`. Checked against Boca's live queue on 2026-10-26 (Chrome windows only). Windows are removed from `windows` via `closeWindow()`, and ranking stops once `queuePassed` is set.

**Cleanup (`closeAll`, on SIGINT/SIGTERM).** Playwright is launched with `handleSIGINT: false` so it doesn't exit before cleanup. Private-window processes are killed with `pkill -f <PROFILES_DIR>` (matching on the profile path, since browsers like Opera re-parent away from the spawned PID), then `.profiles/` is deleted. A leftover `.profiles/` directory means a previous run didn't exit cleanly; it's git-ignored and safe to delete.

**Hardcoded paths** that depend on how each browser is installed on Ubuntu: Brave at `/opt/brave.com/brave/brave`, Opera at `/usr/lib/x86_64-linux-gnu/opera-stable/opera`, and the CLI commands `google-chrome`, `microsoft-edge`, `brave-browser`, `opera` on `PATH`. A browser that fails to launch is logged and skipped rather than aborting the run.
