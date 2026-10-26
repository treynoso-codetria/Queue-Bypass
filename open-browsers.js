// Opens several browsers (Chrome, Edge, Brave, Opera, Firefox) and navigates each to a URL:
// normal windows driven by Playwright, plus real incognito/private windows.
//
// Usage:
//   node open-browsers.js [--chrome N] [--edge N] [--brave N] [--opera N] [--firefox N]
//                         [--private N] [--url URL] [--screen WxH+X+Y] [--keep-all]
//                         [--keep-best N] [--max-wait M] [--no-dump-queue] [--no-hidden]
//
//   --<browser> N     normal windows for that browser (default 4, 0 to skip the browser)
//   --private N       incognito/private windows per browser (default 1, 0 to disable)
//   --screen WxH+X+Y  area to tile the windows over (default: the primary monitor's usable
//                     area, detected with xrandr / _NET_WORKAREA)
//   --keep-all        don't close the other windows when one gets through the queue
//   --keep-best N     every minute, close all queued windows but the N with the shortest wait
//   --max-wait M      every minute, close queued windows whose wait is over M minutes
//   --no-dump-queue   don't save what's read from each queue page to queue-dumps/ (saved by
//                     default, to tune parsing)
//   --no-hidden       show and tile the windows. By default the Chromium windows are minimized
//                     (the one that gets through the queue is restored); Firefox ones can't be
//                     minimized on Wayland, so they always show.
//
// Example:
//   node open-browsers.js --chrome 3 --opera 0 --private 2 --no-hidden
//
// Window layout (with --no-hidden): the Chromium-based browsers are tiled in a grid over the screen (one column
// per browser when possible, normal on top, private below). Their UI is scaled down when a grid
// cell is narrower than their minimum window width. Firefox windows get the same cell size, but
// GNOME decides where they go: Firefox crashes under XWayland here, and native Wayland windows
// can't choose their position.
//
// Queue watch: once a window goes from the Queue-it waiting room to the Boca site, every other
// window is closed so only one session keeps polling the site's API (which blocks IPs that
// poll too much). Firefox private windows can't be watched, but they do get closed.
//
// Queue ranking: every minute, each window's Queue-it page is read (estimated wait, position,
// queue ID, CAPTCHA/block) and printed as a table, shortest wait first. Windows sharing a
// queue ID and blocked windows are reported. It only reads pages already loaded, so it adds no
// requests. --keep-best / --max-wait use it to close the windows with the longest waits.
//
// Windows stay open until you press Ctrl+C.

import { chromium, firefox } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";

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

// Where --dump-queue saves what's read from the queue pages. Git-ignored, kept after exit.
const DUMPS_DIR = join(import.meta.dirname, "queue-dumps");

// How often the queue ranking reads the windows. Queue-it updates its estimate every minute.
const RANK_INTERVAL_MS = 60_000;
// Used instead while some window is a minute or less from getting in.
const RANK_INTERVAL_SOON_MS = 10_000;

// Columns of the ranking table printed by printRanking().
const COLUMNS = [
  { title: "#", width: 2 },
  { title: "Window", width: 18 },
  { title: "Wait", width: 10 },
  { title: "Position", width: 9 },
  { title: "Progress", width: 10 },
  { title: "Queue ID", width: 36 },
];

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      Object.keys(BROWSERS).map((name) => [
        name,
        { type: "string", default: "4" },
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
    "dump-queue": { type: "boolean", default: true },
    hidden: { type: "boolean", default: true },
  },
  allowNegative: true, // --no-hidden, --no-dump-queue
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
function computeGrid(labels, screen) {
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
//   { label, pages() -> [[key, url]], queuePage() -> collectQueuePage() result | null, close() }
const windows = [];
let queuePassed = false; // set once a window gets through the queue

function trackPlaywrightWindow(label, context, show = async () => {}) {
  windows.push({
    label,
    show,
    pages: async () => context.pages().map((p) => [p, p.url()]),
    queuePage: async () => {
      const page = context.pages().find((p) => hostOf(p.url()) === QUEUE_HOST);
      return page ? page.evaluate(collectQueuePage).catch(() => null) : null;
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
    warn(`[${name}] could not launch, skipping: ${err.message.split("\n")[0]}`);
    return;
  }
  launched.push(browser);

  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const label = `${name} #${i + 1}`;
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();

      // Move/resize this context's window through the DevTools protocol.
      const { x, y, width, height } = toUiUnits(grid.cells[label]);
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const setState = (windowState) =>
        cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState } });
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: x, top: y, width, height, windowState: "normal" },
      });
      // Minimized windows keep running normally: Playwright disables background throttling.
      if (values.hidden) await setState("minimized");
      trackPlaywrightWindow(label, context, () => setState("normal"));

      await page.goto(values.url);
      logOpened(label);
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
      writeFirefoxProfile(profile, firefoxCell);

      let context;
      try {
        context = await firefox.launchPersistentContext(profile, {
          headless: false,
          handleSIGINT: false,
          viewport: null,
        });
      } catch (err) {
        warn(`[${label}] could not launch, skipping: ${err.message.split("\n")[0]}`);
        return;
      }
      launched.push(context);
      trackPlaywrightWindow(label, context);

      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(values.url);
      logOpened(label);
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
        show: () => setPrivateWindowState(profile, "normal"),
        pages: async () =>
          (await devToolsTargets(profile)).map((t) => [t.id, t.url]),
        queuePage: () => devToolsQueuePage(profile),
        close: () => killProfile(profile),
      });
    } else {
      writeFirefoxProfile(profile, firefoxCell);
      windows.push({
        label,
        show: async () => {},
        pages: async () => [],
        queuePage: async () => null,
        close: () => killProfile(profile),
      });
    }

    const proc = spawn(command, args, { detached: true, stdio: "ignore" });
    proc.on("error", (err) =>
      warn(`[${label}] could not launch: ${err.message}`),
    );
    proc.on("spawn", () => {
      logOpened(label);
      if (values.hidden && engine === chromium)
        setPrivateWindowState(profile, "minimized");
    });
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

// Sends one DevTools protocol command over a WebSocket and resolves with its result (null on
// error or after 5 s).
function cdpSend(wsUrl, method, params = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const done = (value) => {
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id === 1) done(msg.result ?? null);
    };
    ws.onerror = () => done(null);
  });
}

// collectQueuePage() run in a private Chromium window's Queue-it tab, through the DevTools
// protocol.
async function devToolsQueuePage(profile) {
  const target = (await devToolsTargets(profile)).find(
    (t) => hostOf(t.url) === QUEUE_HOST,
  );
  if (!target) return null;
  const res = await cdpSend(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: `(${collectQueuePage})()`,
    returnByValue: true,
  });
  return res?.result?.value ?? null;
}

// Minimizes or restores a private Chromium window through its browser-level DevTools endpoint.
// Retries for a while, since the window may still be starting.
async function setPrivateWindowState(profile, windowState) {
  for (let tries = 0; tries < 30; tries++) {
    try {
      const [port, path] = readFileSync(
        join(profile, "DevToolsActivePort"),
        "utf8",
      ).split("\n");
      const [target] = await devToolsTargets(profile);
      const browserWs = `ws://127.0.0.1:${port}${path}`;
      const win =
        target &&
        (await cdpSend(browserWs, "Browser.getWindowForTarget", {
          targetId: target.id,
        }));
      if (win) {
        await cdpSend(browserWs, "Browser.setWindowBounds", {
          windowId: win.windowId,
          bounds: { windowState },
        });
        return;
      }
    } catch {} // not started yet
    await new Promise((r) => setTimeout(r, 1000));
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
    for (const win of [...windows]) {
      for (const [key, url] of await win.pages()) {
        const host = hostOf(url);
        if (host === QUEUE_HOST) {
          queued.add(key);
        } else if (host === SITE_HOST && queued.has(key)) {
          // \x07 rings the terminal bell.
          console.log(
            "\x07\n" +
              styleText(
                ["bold", "green"],
                `[${win.label}] got through the queue! Closing the other windows...`,
              ),
          );
          queuePassed = true;
          await win.show().catch(() => {});
          const others = windows.filter((w) => w !== win);
          await Promise.allSettled(others.map(closeWindow));
          console.log(styleText(["bold", "green"], `Only [${win.label}] is left open.`));
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Runs inside a Queue-it page (it's serialized, so it must be self-contained). The element IDs
// are those of Queue-it's standard layout, as used by github.com/Pablosnt07/boca-fila-monitor;
// they're not yet checked against Boca's queue, so the page text is kept as a fallback.
function collectQueuePage() {
  const visible = (el) =>
    !!el &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const text = (selector) => {
    const el = document.querySelector(selector);
    return visible(el) ? el.innerText.trim() : "";
  };
  // Queue-it's knockout view model holds the ticket values even when the layout hides them
  // (Boca's hides the wait and the position).
  const vm = window.queueViewModel;
  const unwrap = (v) => {
    try {
      return typeof v === "function" ? v() : (v ?? null);
    } catch {
      return null;
    }
  };
  const ticket = Object.fromEntries(
    [
      "whichIsIn",
      "queueNumber",
      "usersInLineAheadOfYou",
      "expectedServiceTime",
      "expectedServiceTimeUTC",
      "progress",
      "usersInQueue",
    ].map((key) => [key, unwrap(vm?.ticket?.[key])]),
  );
  return {
    url: location.href,
    text: document.body?.innerText ?? "",
    prequeue: !!document.body?.classList.contains("before"),
    ticket,
    wait:
      text("#MainPart_lbExpectedServiceTimeRelative") || text("#MainPart_lbWhichIsIn"),
    position:
      text("#MainPart_lbQueueNumber") || text("#MainPart_lbUsersInLineAheadOfYou"),
    queueId:
      text("#MainPart_lbQueueId") ||
      text("#hlLinkToQueueTicket2") ||
      String(unwrap(vm?.queueId) ?? "") ||
      text("#queueId") ||
      document.querySelector("[data-queue-id]")?.getAttribute("data-queue-id") ||
      "",
    captcha: [...document.querySelectorAll("iframe")].some(
      (f) => visible(f) && /captcha|challenge/i.test(f.src),
    ),
  };
}

// Lowercase without accents, so the patterns below don't depend on how the page spells them.
function plain(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// "34 minutos", "1 hora y 5 minutos", "menos de un minuto"... to minutes, or null.
function parseDuration(text) {
  const t = plain(text);
  if (/menos de (un|1) minuto/.test(t)) return 0;
  const count = (word) => (/^\d+$/.test(word) ? Number(word) : 1); // "un"/"una" = 1
  const hours = /\b(\d+|una?)\s*horas?\b/.exec(t);
  const minutes = /\b(\d+|un)\s*minutos?\b/.exec(t);
  if (!hours && !minutes) return null;
  return (hours ? count(hours[1]) * 60 : 0) + (minutes ? count(minutes[1]) : 0);
}

// The estimated wait in the page text, e.g. "Entrarás a la página web dentro de: 34 minutos".
// Not yet checked against a live queue: run with --dump-queue to collect real texts.
function parseWaitMinutes(text) {
  const estimate = /dentro de:?\s*([\s\S]{0,60})/.exec(plain(text))?.[1];
  return estimate ? parseDuration(estimate) : null;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// Turns collectQueuePage()'s result into { wait, position, queueId, blocked }; each field is
// null when the page doesn't show it.
function interpretQueuePage(page) {
  const text = plain(page.text);

  const ticket = page.ticket ?? {};
  const serviceAt = Date.parse(ticket.expectedServiceTimeUTC ?? "");
  const waitText = [page.wait, String(ticket.whichIsIn ?? "")].find(
    (t) => parseDuration(t) !== null,
  );
  const wait =
    (waitText && parseDuration(waitText)) ??
    (serviceAt ? Math.max(0, Math.round((serviceAt - Date.now()) / 60000)) : null) ??
    parseWaitMinutes(page.text);
  // "más de una hora": the wait is at least `wait`, not exactly.
  const waitOver = !!waitText && /\bmas de\b/.test(plain(waitText));
  const progress = typeof ticket.progress === "number" ? ticket.progress : null;

  const positionText =
    page.position ||
    String(ticket.queueNumber ?? ticket.usersInLineAheadOfYou ?? "") ||
    /(?:numero en la fila|posicion en la fila|tu posicion|tu numero)[^\d\n]{0,20}(\d[\d.,]*)/.exec(
      text,
    )?.[1] ||
    "";
  const position = /^\d[\d.,\s]*$/.test(positionText.trim())
    ? Number(positionText.replace(/\D/g, ""))
    : null;

  let urlQueueId = null;
  try {
    urlQueueId = new URL(page.url).searchParams.get("q");
  } catch {}
  const queueId =
    [
      page.queueId,
      urlQueueId,
      /(?:id|identificador)[^\n]{0,40}?([0-9a-f-]{36})/.exec(text)?.[1],
    ]
      .map((candidate) => UUID.exec(plain(candidate ?? ""))?.[0])
      .find(Boolean) ?? null;

  const blocked =
    page.captcha ||
    /captcha|verifica que eres humano|verify you are human|acceso bloqueado|access denied|too many requests|demasiadas solicitudes/.test(
      text,
    );

  return {
    wait,
    waitOver,
    position,
    progress,
    queueId,
    blocked,
    prequeue: !!page.prequeue,
  };
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

// Every RANK_INTERVAL_MS, reads each window still in the queue, prints them shortest wait first
// (position breaks ties), reports blocked windows and shared queue IDs, and applies
// --keep-best / --max-wait.
async function rankQueue() {
  const warned = new Set(); // windows already warned about (unparsed or blocked), once each

  let interval = RANK_INTERVAL_MS;
  while (!queuePassed) {
    await new Promise((r) => setTimeout(r, interval));
    if (queuePassed) return;

    const rows = await Promise.all(
      windows.map(async (win) => {
        const page = await win.queuePage().catch(() => null);
        if (page && values["dump-queue"]) {
          mkdirSync(DUMPS_DIR, { recursive: true });
          writeFileSync(
            join(DUMPS_DIR, `${win.label}.json`),
            JSON.stringify(page, null, 2),
          );
        }
        return { win, info: page && interpretQueuePage(page), page };
      }),
    );
    if (queuePassed) return;

    for (const { win, info, page } of rows) {
      if (!info || warned.has(win)) continue;
      if (info.blocked) {
        warned.add(win);
        warn(
          `[${win.label}] shows a CAPTCHA or block page: open it and check it by hand. ` +
            "If several windows show this, close some to lower the load.",
        );
      } else if (info.wait === null && !info.prequeue) {
        warned.add(win);
        const snippet = page.text.replace(/\s+/g, " ").slice(0, 200);
        warn(`[${win.label}] couldn't find the wait time in: "${snippet}"`);
      }
    }

    const inQueue = rows.filter((r) => r.info);
    const known = inQueue
      .filter((r) => r.info.wait !== null && !r.info.blocked)
      .sort(
        (a, b) =>
          a.info.wait - b.info.wait ||
          a.info.waitOver - b.info.waitOver ||
          (b.info.progress ?? -1) - (a.info.progress ?? -1) ||
          (a.info.position ?? Infinity) - (b.info.position ?? Infinity),
      );
    interval = known[0]?.info.wait <= 1 ? RANK_INTERVAL_SOON_MS : RANK_INTERVAL_MS;
    if (inQueue.length === 0) continue; // nobody in the queue yet (or anymore)

    printRanking(known, rows.filter((r) => !known.includes(r)));

    // Windows with the same queue ID hold the same place in line, so only one of them counts.
    const byId = Map.groupBy(
      inQueue.filter((r) => r.info.queueId),
      (r) => r.info.queueId,
    );
    for (const [id, same] of byId)
      if (same.length > 1)
        warn(
          `Same queue ID ${id} in: ${same.map((r) => r.win.label).join(", ")}. ` +
            "They're one place in line, not several.",
        );

    // Only windows with a known wait are closed (never blocked or unknown ones), and the
    // shortest one is always kept.
    const toClose = known.filter(
      ({ info }, i) => i > 0 && (i >= keepBest || info.wait > maxWait),
    );
    for (const { win, info } of toClose) {
      console.log(
        styleText("dim", `[${win.label}] closing, wait ${formatWait(info)[0]}`),
      );
      await closeWindow(win);
    }
  }
}

function warn(message) {
  console.warn(styleText("yellow", `⚠ ${message}`));
}

function logOpened(label) {
  console.log(styleText("dim", `[${label}] opened ${values.url}`));
}

// The wait column's text and style for a window.
function formatWait(info) {
  if (!info) return ["no data", "dim"]; // not on the queue page, or unreadable (Firefox private)
  if (info.blocked) return ["CAPTCHA", ["bold", "red"]];
  if (info.wait === null)
    return info.prequeue ? ["prequeue", "dim"] : ["unknown", "yellow"];
  const { wait, waitOver } = info;
  const minutes = wait % 60;
  const text =
    wait === 0
      ? "< 1 min"
      : wait < 60
        ? `${wait} min`
        : `${Math.floor(wait / 60)} h` + (minutes ? ` ${minutes} min` : "");
  return [
    waitOver ? `> ${text}` : text,
    wait <= 1 ? ["bold", "green"] : null,
  ];
}

// A text progress bar, e.g. "▰▰▰▱▱  45%".
function formatProgress(progress) {
  if (progress === null) return "";
  const pct = Math.round(progress * 100);
  const filled = Math.round(pct / 20);
  return "▰".repeat(filled) + "▱".repeat(5 - filled) + `${pct}%`.padStart(5);
}

function tableLine(left, mid, right) {
  return styleText(
    "dim",
    left + COLUMNS.map((c) => "─".repeat(c.width + 2)).join(mid) + right,
  );
}

// cells: one [text, style] per column; style is a styleText() format, or null for none.
function tableRow(cells) {
  const bar = styleText("dim", "│");
  const fitted = cells.map(([text, style], i) => {
    const { width } = COLUMNS[i];
    const padded =
      text.length > width ? text.slice(0, width - 1) + "…" : text.padEnd(width);
    return ` ${style ? styleText(style, padded) : padded} `;
  });
  return bar + fitted.join(bar) + bar;
}

// Prints the ranking table: `ranked` rows (known wait, shortest first) are numbered and the best
// one is highlighted; `others` (prequeue, blocked, unknown, unreadable) follow.
function printRanking(ranked, others) {
  const time = new Date().toLocaleTimeString("es-AR");
  console.log(
    "\n" +
      styleText("bold", "Queue status") +
      styleText("dim", ` · ${time} · ${ranked.length} of ${ranked.length + others.length} windows ranked`),
  );
  console.log(tableLine("┌", "┬", "┐"));
  console.log(tableRow(COLUMNS.map((c) => [c.title, "bold"])));
  console.log(tableLine("├", "┼", "┤"));
  for (const [i, { win, info }] of [...ranked, ...others].entries()) {
    const isRanked = i < ranked.length;
    const best = i === 0 && isRanked;
    const rank = isRanked ? String(i + 1).padStart(2) : info?.blocked ? " !" : " ·";
    console.log(
      tableRow([
        [rank, best ? ["bold", "green"] : isRanked ? null : "dim"],
        [win.label, best ? ["bold", "green"] : isRanked ? null : "dim"],
        formatWait(info),
        [info?.position?.toLocaleString("es-AR") ?? "", null],
        [formatProgress(info?.progress ?? null), "cyan"],
        [info?.queueId ?? "", "dim"],
      ]),
    );
  }
  console.log(tableLine("└", "┴", "┘"));
}

async function closeAll() {
  console.log(styleText("dim", "\nClosing browsers..."));
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
const chromiumLabels = enabled
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
  ]);
const firefoxCount = enabled.includes("firefox")
  ? Number(values.firefox) + privateCount
  : 0;
const screen = detectScreen();
// Hidden: the minimized Chromium windows all get the whole screen, so the one that gets through
// is restored full size and unscaled, and only the (visible) Firefox windows share the screen.
const grid = values.hidden
  ? {
      cells: Object.fromEntries(chromiumLabels.map((l) => [l, screen])),
      width: screen.width,
      height: screen.height,
    }
  : computeGrid(chromiumLabels, screen);
const firefoxCell = values.hidden
  ? computeGrid(Array.from({ length: firefoxCount }, String), screen)
  : grid;
const chromiumScale = Math.min(
  1,
  Math.floor((grid.width / CHROMIUM_MIN_WIDTH) * 100) / 100,
);

console.log(
  styleText("bold", `Opening ${chromiumLabels.length + firefoxCount} windows`) +
    styleText(
      "dim",
      ` · ${values.hidden ? "hidden" : "tiled"}` +
        (values["dump-queue"] ? " · saving queue pages to queue-dumps/" : ""),
    ),
);
if (values.hidden && firefoxCount > 0)
  console.log(
    styleText("dim", "Firefox windows stay visible: they can't be minimized on Wayland."),
  );

await Promise.all(
  enabled.map(async (name) => {
    openPrivateWindows(name, privateCount);
    await openNormalWindows(name, Number(values[name]));
  }),
);

if (launched.length === 0 && privateProcs.length === 0) {
  console.error(styleText("red", "No browser could be launched."));
  process.exit(1);
}
console.log(
  styleText("bold", "All windows opened.") +
    styleText("dim", " The ranking is printed every minute. Press Ctrl+C to close them."),
);
if (!values["keep-all"]) watchQueue();
rankQueue();
