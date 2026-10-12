# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automates opening many browser windows (Chrome, Edge, Brave, Opera, Firefox), each in a normal and an incognito/private variant, all pointed at the same URL and tiled over the screen. Target platform is Linux only — specifically Ubuntu 26.04 with GNOME (Wayland session, with XWayland available). The whole program is a single ES module script, `open-browsers.js`, built on Playwright.

## Commands

```bash
npm install                          # installs playwright
npx playwright install firefox       # Playwright's own Firefox build is required (see below)
node open-browsers.js                # 1 normal + 1 private window per browser, default URL
node open-browsers.js --chrome 3 --opera 0 --private 2 --url https://example.com
node open-browsers.js --screen 1920x1080+0+0   # override the auto-detected tiling area
```

`--<browser> N` sets normal windows per browser (0 skips the browser), `--private N` sets private windows per browser. The process stays alive until Ctrl+C, which triggers cleanup. There is no build step, linter, or test suite (`npm test` is the npm placeholder).

## Architecture

**Two launch paths per browser.** Every entry in the `BROWSERS` table describes both:
- *Normal windows* go through Playwright (`engine` + `launchOptions`). For Chromium browsers, one browser process is launched and each window is a separate `browser.newContext()` (isolated cookies/storage), positioned via CDP `Browser.setWindowBounds`.
- *Private windows* are not Playwright-controlled: the real browser binary is `spawn`ed detached (`command` + `privateArgs`) with `--incognito`/`--inprivate`/`--private`/`-private-window`, each with its own throwaway `--user-data-dir` under `.profiles/`, positioned with `--window-position`/`--window-size`.

**Firefox is special-cased throughout:**
- Uses Playwright's bundled Firefox (`firefox.executablePath()`) for *both* paths — the Ubuntu Snap Firefox can't be driven by Playwright and its AppArmor confinement prevents killing it on exit.
- Playwright can't resize Firefox windows, so each normal Firefox window gets its own persistent profile (`launchPersistentContext`), and window size is pre-seeded by writing `xulstore.json` (`writeFirefoxProfile`).
- Firefox runs as a native Wayland window (it crashes under XWayland on this setup), so GNOME chooses its position; it is excluded from the tiling grid and only receives the cell size.

**Window layout.** Chromium browsers are forced onto XWayland (`--ozone-platform=x11` in `CHROMIUM_ARGS`) because native Wayland windows can't be positioned. `detectScreen()` gets the primary monitor from `xrandr` and clips it to `_NET_WORKAREA` from `xprop` (so those tools must be present unless `--screen` is passed). `computeGrid()` fills cells column-by-column so each browser's normal and private windows stack together. Because Chromium refuses windows narrower than ~`CHROMIUM_MIN_WIDTH` UI units, a `--force-device-scale-factor` (`chromiumScale`) is computed to shrink the UI when cells are narrow; all Chromium bounds are converted with `toUiUnits()` (pixels / scale).

Note the module-level ordering: `grid` and `chromiumScale` are top-level `const`s defined after the functions that read them, so they must be computed before any open* function is called.

**Cleanup (`closeAll`, on SIGINT/SIGTERM).** Playwright is launched with `handleSIGINT: false` so it doesn't exit before cleanup. Private-window processes are killed with `pkill -f <PROFILES_DIR>` (matching on the profile path, since browsers like Opera re-parent away from the spawned PID), then `.profiles/` is deleted. A leftover `.profiles/` directory means a previous run didn't exit cleanly; it's git-ignored and safe to delete.

**Hardcoded paths** that depend on how each browser is installed on Ubuntu: Brave at `/opt/brave.com/brave/brave`, Opera at `/usr/lib/x86_64-linux-gnu/opera-stable/opera`, and the CLI commands `google-chrome`, `microsoft-edge`, `brave-browser`, `opera` on `PATH`. A browser that fails to launch is logged and skipped rather than aborting the run.
