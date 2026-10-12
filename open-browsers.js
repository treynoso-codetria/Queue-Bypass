// Opens several browsers (Chrome, Edge, Brave, Opera, Firefox) and navigates each to a URL:
// normal windows driven by Playwright, plus real incognito/private windows.
//
// Usage:
//   node open-browsers.js [--chrome N] [--edge N] [--brave N] [--opera N] [--firefox N]
//                         [--private N] [--url URL] [--screen WxH+X+Y] [--keep-all]
//
//   --<browser> N     normal windows for that browser (default 1, 0 to skip the browser)
//   --private N       incognito/private windows per browser (default 1, 0 to disable)
//   --screen WxH+X+Y  area to tile the windows over (default: the primary monitor's usable
//                     area, detected with xrandr / _NET_WORKAREA)
//   --keep-all        don't close the other windows when one gets through the queue
//
// Example:
//   node open-browsers.js --chrome 3 --opera 0 --private 2
//
// Window layout: the Chromium-based browsers are tiled in a grid over the screen (one column
// per browser when possible, normal on top, private below). Their UI is scaled down when a grid
// cell is narrower than their minimum window width. Firefox windows get the same cell size, but
// GNOME decides where they go: Firefox crashes under XWayland here, and native Wayland windows
// can't choose their position.
//
// Queue watch: once a window goes from the Queue-it waiting room to the Boca site, every other
// window is closed so only one session keeps polling the site's API (which blocks IPs that
// poll too much). Firefox private windows can't be watched, but they do get closed.
//
// Windows stay open until you press Ctrl+C.

import { chromium, firefox } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Each entry describes:
//   engine/launchOptions: how Playwright launches the normal (automated) windows
//   command/privateArgs:  how the browser's own CLI opens an incognito/private window
const BROWSERS = {
  chrome: {
    engine: chromium,
    launchOptions: { channel: "chrome" },
    command: "google-chrome",
    privateArgs: (profile, url) => [
      `--user-data-dir=${profile}`,
      "--incognito",
      url,
    ],
  },
  edge: {
    engine: chromium,
    launchOptions: { channel: "msedge" },
    command: "microsoft-edge",
    privateArgs: (profile, url) => [
      `--user-data-dir=${profile}`,
      "--inprivate",
      url,
    ],
  },
  brave: {
    engine: chromium,
    launchOptions: { executablePath: "/opt/brave.com/brave/brave" },
    command: "brave-browser",
    privateArgs: (profile, url) => [
      `--user-data-dir=${profile}`,
      "--incognito",
      url,
    ],
  },
  opera: {
    engine: chromium,
    launchOptions: {
      executablePath: "/usr/lib/x86_64-linux-gnu/opera-stable/opera",
    },
    command: "opera",
    privateArgs: (profile, url) => [
      `--user-data-dir=${profile}`,
      "--private",
      url,
    ],
  },
  firefox: {
    // Uses Playwright's Firefox build for both window types: the Snap Firefox can't be driven
    // by Playwright, and its AppArmor confinement blocks closing it on Ctrl+C.
    engine: firefox,
    launchOptions: {},
    command: firefox.executablePath(),
    privateArgs: (profile, url) => [
      "-no-remote",
      "-profile",
      profile,
      "-private-window",
      url,
    ],
  },
};

// Flags that skip first-run wizards / default-browser prompts on Chromium-based browsers.
// --ozone-platform=x11 runs them under XWayland: native Wayland windows can't be positioned.
const CHROMIUM_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--ozone-platform=x11",
];

// Chromium browsers refuse to get narrower than this (in UI units; Opera's is the largest at
// ~660, Chrome/Edge/Brave are ~530-570). Used to pick a UI scale that lets windows fit a cell.
const CHROMIUM_MIN_WIDTH = 680;

// A window that goes from QUEUE_HOST to SITE_HOST has gotten through the queue.
const QUEUE_HOST = "bocajuniors.queue-it.net";
const SITE_HOST = "bocasocios.bocajuniors.com.ar";

// Throwaway profiles, deleted on exit.
const PROFILES_DIR = join(import.meta.dirname, ".profiles");

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      Object.keys(BROWSERS).map((name) => [
        name,
        { type: "string", default: "1" },
      ]),
    ),
    private: { type: "string", default: "1" },
    url: {
      type: "string",
      default: "https://bocasocios.bocajuniors.com.ar/home",
    },
    screen: { type: "string" },
    "keep-all": { type: "boolean", default: false },
  },
});

// Returns the area to tile windows over as { x, y, width, height }.
function detectScreen() {
  const parse = (str) => {
    const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(str);
    return m && { width: +m[1], height: +m[2], x: +m[3], y: +m[4] };
  };
  if (values.screen) {
    const area = parse(values.screen);
    if (!area)
      throw new Error(
        `--screen must look like 1920x1080+0+0, got "${values.screen}"`,
      );
    return area;
  }

  // Primary monitor geometry, e.g. "DP-2 connected primary 1920x1080+1366+0".
  const xrandr =
    spawnSync("xrandr", ["--query"], { encoding: "utf8" }).stdout ?? "";
  const monitor =
    parse(/ connected primary (\S+)/.exec(xrandr)?.[1] ?? "") ??
    parse("1920x1080+0+0");

  // Skip panels (e.g. GNOME's top bar): clip the monitor to the desktop's usable work area.
  const workarea =
    spawnSync("xprop", ["-root", "_NET_WORKAREA"], { encoding: "utf8" })
      .stdout ?? "";
  const [wx, wy, ww, wh] = (/= (.*)/.exec(workarea)?.[1] ?? "")
    .split(",")
    .map(Number);
  if (ww > 0 && wh > 0) {
    const left = Math.max(monitor.x, wx);
    const top = Math.max(monitor.y, wy);
    const right = Math.min(monitor.x + monitor.width, wx + ww);
    const bottom = Math.min(monitor.y + monitor.height, wy + wh);
    if (right > left && bottom > top)
      return { x: left, y: top, width: right - left, height: bottom - top };
  }
  return monitor;
}

// Assigns each window label a cell (in screen pixels) of a grid covering the screen. Cells are
// filled column by column, so each browser's normal + private windows end up stacked together.
function computeGrid(labels) {
  const screen = detectScreen();
  const n = Math.max(labels.length, 1);
  const cols = Math.ceil(Math.sqrt((n * screen.width) / screen.height));
  const rows = Math.ceil(n / cols);
  const width = Math.floor(screen.width / Math.ceil(n / rows));
  const height = Math.floor(screen.height / rows);

  const cells = Object.fromEntries(
    labels.map((label, i) => [
      label,
      {
        x: screen.x + Math.floor(i / rows) * width,
        y: screen.y + (i % rows) * height,
        width,
        height,
      },
    ]),
  );
  return { cells, width, height };
}

// Chromium measures window bounds in UI units, which are pixels / scale factor.
function toUiUnits({ x, y, width, height }) {
  const s = chromiumScale;
  return {
    x: Math.round(x / s),
    y: Math.round(y / s),
    width: Math.round(width / s),
    height: Math.round(height / s),
  };
}

// Pre-seeds xulstore.json, where Firefox remembers window geometry, so the profile's first
// window opens at this size. (The position is ignored on Wayland.)
function writeFirefoxProfile(profile, { width, height }) {
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, "xulstore.json"),
    JSON.stringify({
      "chrome://browser/content/browser.xhtml": {
        "main-window": {
          width: String(width),
          height: String(height),
          sizemode: "normal",
        },
      },
    }),
  );
}

const launched = []; // Playwright browsers / persistent contexts (anything with close())
const privateProcs = []; // spawned private-window processes
// Every window, for the queue watch: { label, pages() -> [[key, url]], close() }
const windows = [];

async function openNormalWindows(name, count) {
  const { engine } = BROWSERS[name];
  if (engine === firefox) return openFirefoxNormalWindows(count);

  // Chromium-based: one browser process, one isolated context (own cookies/storage) per window.
  let browser;
  try {
    // handleSIGINT: false so Playwright doesn't exit before closeAll() finishes cleaning up.
    browser = await engine.launch({
      headless: false,
      handleSIGINT: false,
      args: [...CHROMIUM_ARGS, `--force-device-scale-factor=${chromiumScale}`],
      ...BROWSERS[name].launchOptions,
    });
  } catch (err) {
    console.warn(
      `[${name}] could not launch, skipping: ${err.message.split("\n")[0]}`,
    );
    return;
  }
  launched.push(browser);

  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const label = `${name} #${i + 1}`;
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      windows.push({
        label,
        pages: async () => context.pages().map((p) => [p, p.url()]),
        close: () => context.close(),
      });

      // Move/resize this context's window through the DevTools protocol.
      const { x, y, width, height } = toUiUnits(grid.cells[label]);
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: x, top: y, width, height, windowState: "normal" },
      });

      await page.goto(values.url);
      console.log(`[${label}] opened ${values.url}`);
    }),
  );
}

// Playwright can't resize Firefox windows, so each normal Firefox window gets its own persistent
// profile with the size pre-seeded (see writeFirefoxProfile).
async function openFirefoxNormalWindows(count) {
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const label = `firefox #${i + 1}`;
      const profile = join(PROFILES_DIR, `firefox-normal-${i + 1}`);
      writeFirefoxProfile(profile, grid);

      let context;
      try {
        context = await firefox.launchPersistentContext(profile, {
          headless: false,
          handleSIGINT: false,
          viewport: null,
        });
      } catch (err) {
        console.warn(
          `[${label}] could not launch, skipping: ${err.message.split("\n")[0]}`,
        );
        return;
      }
      launched.push(context);
      windows.push({
        label,
        pages: async () => context.pages().map((p) => [p, p.url()]),
        close: () => context.close(),
      });

      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(values.url);
      console.log(`[${label}] opened ${values.url}`);
    }),
  );
}

function openPrivateWindows(name, count) {
  const { engine, command, privateArgs } = BROWSERS[name];

  for (let i = 1; i <= count; i++) {
    const label = `${name} private #${i}`;
    const profile = join(PROFILES_DIR, `${name}-private-${i}`);

    const args = privateArgs(profile, values.url);
    if (engine === chromium) {
      mkdirSync(profile, { recursive: true });
      rmSync(join(profile, "DevToolsActivePort"), { force: true });
      const { x, y, width, height } = toUiUnits(grid.cells[label]);
      // Port 0 picks a free DevTools port and writes it to <profile>/DevToolsActivePort,
      // which lets the queue watch read this window's tabs.
      args.unshift(
        ...CHROMIUM_ARGS,
        "--remote-debugging-port=0",
        `--force-device-scale-factor=${chromiumScale}`,
        `--window-position=${x},${y}`,
        `--window-size=${width},${height}`,
      );
      windows.push({
        label,
        pages: () => devToolsPages(profile),
        close: () => killProfile(profile),
      });
    } else {
      writeFirefoxProfile(profile, grid);
      windows.push({
        label,
        pages: async () => [],
        close: () => killProfile(profile),
      });
    }

    const proc = spawn(command, args, { detached: true, stdio: "ignore" });
    proc.on("error", (err) =>
      console.warn(`[${label}] could not launch: ${err.message}`),
    );
    proc.on("spawn", () => console.log(`[${label}] opened ${values.url}`));
    privateProcs.push(proc);
  }
}

// Tabs of a private Chromium window, read from its DevTools HTTP endpoint.
async function devToolsPages(profile) {
  try {
    const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
      .split("\n")[0];
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await res.json();
    return targets
      .filter((t) => t.type === "page")
      .map((t) => [t.id, t.url]);
  } catch {
    return []; // not started yet, or already gone
  }
}

// Kills the processes using this profile. The trailing "( |$)" keeps "chrome-private-1" from
// also matching "chrome-private-10".
function killProfile(profile) {
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  spawnSync("pkill", ["-TERM", "-f", `${escaped}( |$)`]);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// Polls every window's tabs until one goes from the Queue-it waiting room to the Boca site,
// then closes all the other windows.
async function watchQueue() {
  const queued = new Set(); // keys of tabs that have been on QUEUE_HOST
  for (;;) {
    for (const win of windows) {
      for (const [key, url] of await win.pages()) {
        const host = hostOf(url);
        if (host === QUEUE_HOST) {
          queued.add(key);
        } else if (host === SITE_HOST && queued.has(key)) {
          console.log(
            `[${win.label}] got through the queue, closing the other windows...`,
          );
          const others = windows.filter((w) => w !== win);
          await Promise.allSettled(others.map((w) => w.close()));
          console.log(`Only [${win.label}] is left open.`);
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function closeAll() {
  console.log("\nClosing browsers...");
  // Some browsers (e.g. Opera) re-parent themselves away from the process we
  // spawned, so find the private-window processes by their profile path instead.
  if (privateProcs.length > 0) {
    spawnSync("pkill", ["-TERM", "-f", PROFILES_DIR]);
  }
  await Promise.allSettled(launched.map((b) => b.close()));
  // Give the browsers a moment to exit, force-kill stragglers, then delete the profiles.
  await new Promise((r) => setTimeout(r, 1500));
  if (privateProcs.length > 0) {
    spawnSync("pkill", ["-KILL", "-f", PROFILES_DIR]);
  }
  rmSync(PROFILES_DIR, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", closeAll);
process.on("SIGTERM", closeAll);

const privateCount = Number(values.private);
const enabled = Object.keys(BROWSERS).filter(
  (name) => Number(values[name]) > 0,
);

// Grid cells for the Chromium windows, in display order: each browser's normal windows, then
// its private ones. Firefox windows aren't in the grid since they can't be positioned.
const grid = computeGrid(
  enabled
    .filter((name) => BROWSERS[name].engine === chromium)
    .flatMap((name) => [
      ...Array.from(
        { length: Number(values[name]) },
        (_, i) => `${name} #${i + 1}`,
      ),
      ...Array.from(
        { length: privateCount },
        (_, i) => `${name} private #${i + 1}`,
      ),
    ]),
);
const chromiumScale = Math.min(
  1,
  Math.floor((grid.width / CHROMIUM_MIN_WIDTH) * 100) / 100,
);

await Promise.all(
  enabled.map(async (name) => {
    openPrivateWindows(name, privateCount);
    await openNormalWindows(name, Number(values[name]));
  }),
);

if (launched.length === 0 && privateProcs.length === 0) {
  console.error("No browser could be launched.");
  process.exit(1);
}
console.log("All windows opened. Press Ctrl+C to close them.");
if (!values["keep-all"]) watchQueue();
