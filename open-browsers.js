// Opens several browsers (Chrome, Edge, Brave, Opera, Firefox) and navigates each to a URL:
// normal windows driven by Playwright, plus real incognito/private windows.
//
// Usage:
//   node open-browsers.js [--chrome N] [--edge N] [--brave N] [--opera N] [--firefox N]
//                         [--private N] [--url URL] [--screen WxH+X+Y] [--keep-all]
//                         [--keep-best N] [--max-wait M] [--dump-queue]
//
//   --<browser> N     normal windows for that browser (default 1, 0 to skip the browser)
//   --private N       incognito/private windows per browser (default 1, 0 to disable)
//   --screen WxH+X+Y  area to tile the windows over (default: the primary monitor's usable
//                     area, detected with xrandr / _NET_WORKAREA)
//   --keep-all        don't close the other windows when one gets through the queue
//   --keep-best N     every minute, close all queued windows but the N with the shortest wait
//   --max-wait M      every minute, close queued windows whose wait is over M minutes
//   --dump-queue      save each window's queue page text to queue-dumps/ (to tune the parser)
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
// Queue ranking: every minute, the estimated wait shown on each window's Queue-it page is read
// and printed as a table, shortest first. It only reads pages already loaded, so it adds no
// requests. --keep-best / --max-wait use it to close the windows with the longest waits.
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

// Where --dump-queue saves the queue page texts. Git-ignored, kept after exit.
const DUMPS_DIR = join(import.meta.dirname, "queue-dumps");

// How often the queue ranking reads the windows. Queue-it updates its estimate every minute.
const RANK_INTERVAL_MS = 60_000;

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
    "keep-best": { type: "string" },
    "max-wait": { type: "string" },
    "dump-queue": { type: "boolean", default: false },
  },
});
const keepBest = positiveFlag("keep-best");
const maxWait = positiveFlag("max-wait");

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
// Every open window, for the queue watch and ranking:
//   { label, pages() -> [[key, url]], queueText() -> string | null, close() }
const windows = [];
let queuePassed = false; // set once a window gets through the queue

function trackPlaywrightWindow(label, context) {
  windows.push({
    label,
    pages: async () => context.pages().map((p) => [p, p.url()]),
    queueText: async () => {
      const page = context.pages().find((p) => hostOf(p.url()) === QUEUE_HOST);
      return page
        ? page.innerText("body", { timeout: 5000 }).catch(() => null)
        : null;
    },
    close: () => context.close(),
  });
}

function closeWindow(win) {
  windows.splice(windows.indexOf(win), 1);
  return win.close();
}

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
      trackPlaywrightWindow(label, context);

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
      trackPlaywrightWindow(label, context);

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
        pages: async () =>
          (await devToolsTargets(profile)).map((t) => [t.id, t.url]),
        queueText: () => devToolsQueueText(profile),
        close: () => killProfile(profile),
      });
    } else {
      writeFirefoxProfile(profile, grid);
      windows.push({
        label,
        pages: async () => [],
        queueText: async () => null,
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
async function devToolsTargets(profile) {
  try {
    const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
      .split("\n")[0];
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await res.json();
    return targets.filter((t) => t.type === "page");
  } catch {
    return []; // not started yet, or already gone
  }
}

// Text of a private Chromium window's Queue-it tab, read through the DevTools protocol.
async function devToolsQueueText(profile) {
  const target = (await devToolsTargets(profile)).find(
    (t) => hostOf(t.url) === QUEUE_HOST,
  );
  if (!target) return null;

  return new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const done = (value) => {
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 5000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "document.body.innerText", returnByValue: true },
        }),
      );
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id === 1) done(msg.result?.result?.value ?? null);
    };
    ws.onerror = () => done(null);
  });
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
    for (const win of [...windows]) {
      for (const [key, url] of await win.pages()) {
        const host = hostOf(url);
        if (host === QUEUE_HOST) {
          queued.add(key);
        } else if (host === SITE_HOST && queued.has(key)) {
          console.log(
            `[${win.label}] got through the queue, closing the other windows...`,
          );
          queuePassed = true;
          const others = windows.filter((w) => w !== win);
          await Promise.allSettled(others.map(closeWindow));
          console.log(`Only [${win.label}] is left open.`);
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Turns Queue-it's estimated wait into minutes, or null if the text has none. Expects wording
// like "Entrarás a la página web dentro de: 34 minutos" (or "1 hora y 5 minutos", "menos de un
// minuto"). Not yet checked against a live queue: run with --dump-queue to collect real texts.
function parseWaitMinutes(text) {
  const plain = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase();
  const estimate = /dentro de:?\s*([\s\S]{0,60})/.exec(plain)?.[1];
  if (!estimate) return null;
  if (/menos de (un|1) minuto/.test(estimate)) return 0;

  const count = (word) => (/^\d+$/.test(word) ? Number(word) : 1); // "un"/"una" = 1
  const hours = /\b(\d+|una?)\s*horas?\b/.exec(estimate);
  const minutes = /\b(\d+|un)\s*minutos?\b/.exec(estimate);
  if (!hours && !minutes) return null;
  return (hours ? count(hours[1]) * 60 : 0) + (minutes ? count(minutes[1]) : 0);
}

// Value of a numeric flag, Infinity when it's not given. Exits on anything but a number >= 1.
function positiveFlag(name) {
  if (values[name] === undefined) return Infinity;
  const n = Number(values[name]);
  if (!(n >= 1)) {
    console.error(`--${name} must be a number >= 1, got "${values[name]}"`);
    process.exit(1);
  }
  return n;
}

// Every RANK_INTERVAL_MS, reads the estimated wait of each window still in the queue, prints
// them shortest first, and applies --keep-best / --max-wait.
async function rankQueue() {
  const warned = new Set(); // windows whose text couldn't be parsed, warned once

  while (!queuePassed) {
    await new Promise((r) => setTimeout(r, RANK_INTERVAL_MS));
    if (queuePassed) return;

    const rows = await Promise.all(
      windows.map(async (win) => {
        const text = await win.queueText().catch(() => null);
        if (text && values["dump-queue"]) {
          mkdirSync(DUMPS_DIR, { recursive: true });
          writeFileSync(join(DUMPS_DIR, `${win.label}.txt`), text);
        }
        const wait = text === null ? null : parseWaitMinutes(text);
        if (text !== null && wait === null && !warned.has(win)) {
          warned.add(win);
          const snippet = text.replace(/\s+/g, " ").slice(0, 200);
          console.warn(`[${win.label}] couldn't find the wait time in: "${snippet}"`);
        }
        return { win, wait };
      }),
    );
    if (queuePassed) return;

    const known = rows
      .filter((r) => r.wait !== null)
      .sort((a, b) => a.wait - b.wait);
    const unknown = rows.filter((r) => r.wait === null);
    if (known.length === 0) continue; // nobody in the queue yet (or anymore)
    console.log("\nEstimated wait per window:");
    known.forEach(({ win, wait }, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${win.label.padEnd(20)} ${wait} min`),
    );
    for (const { win } of unknown)
      console.log(`   -. ${win.label.padEnd(20)} unknown`);

    // Only windows with a known wait are closed, and the shortest one is always kept.
    const toClose = known.filter(
      ({ wait }, i) => i > 0 && (i >= keepBest || wait > maxWait),
    );
    for (const { win, wait } of toClose) {
      console.log(`[${win.label}] closing, wait ${wait} min`);
      await closeWindow(win);
    }
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
rankQueue();
