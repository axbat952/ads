/**
 * What the picture does when an ad break ends, in a real Chrome.
 *
 *     node tests/breakend.mjs <live channel> [runs]
 *
 * The return to live is the one moment the offline tests cannot judge: they
 * prove which numbers and tags the player is handed, not what it makes of
 * them. A fresh profile almost always gets a preroll, so each run loads the
 * channel with the extension, waits for the break to end, and then watches for
 * thirty seconds:
 *
 * - **stall**: the longest stretch without `currentTime` moving. A return that
 *   freezes the picture shows up here.
 * - **join**: the gap the engine logged when it switched back — the replay,
 *   when negative. The player's own `getLiveLatency()` cannot measure it: it
 *   is reckoned from the player's buffer, and stayed flat through a measured
 *   eight-second replay.
 * - **error**: whether the `<video>` element reported one.
 *
 * Exit code 1 if a run stalls or no break was seen in any run.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PROFILE = join(ROOT, ".smoke-profile");
const PORT = 9341;
const CHANNEL = process.argv[2];
const RUNS = Number(process.argv[3]) || 1;

/** Longest acceptable stretch without progress after the return, in seconds. */
const STALL_LIMIT = 2;

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener("open", () =>
      resolve({
        send: (method, params) =>
          new Promise((res) => {
            id += 1;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          }),
      }));
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
  });
}

/** The picture, read the way the page itself would: the largest video. */
const PROBE = `(() => {
  let best = null, area = -1;
  for (const v of document.querySelectorAll("video")) {
    const b = v.getBoundingClientRect();
    if (b.width * b.height > area) { area = b.width * b.height; best = v; }
  }
  return {
    t: best ? best.currentTime : null,
    error: best && best.error ? best.error.code : null,
    visible: document.visibilityState === "visible",
  };
})()`;

async function engineLog(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const worker = list.find((t) => t.type === "service_worker" && t.url.includes("background"));
  if (!worker) return [];
  const sw = await connect(worker.webSocketDebuggerUrl);
  const r = await sw.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `chrome.storage.local.get("twitch-ads-remove-state").then((s) =>
      ((s["twitch-ads-remove-state"] || {}).log || []).map((l) => l.message))`,
  });
  return (r.result && r.result.result && r.result.result.value) || [];
}

async function run(n) {
  rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--enable-unsafe-extension-debugging", "--no-first-run",
    "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    // A window covered by others is reported hidden on Windows, and a hidden
    // tab never plays: the run then measures the desktop, not the extension.
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    let version;
    for (let i = 0; i < 40 && !version; i += 1) {
      await wait(500);
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    const browser = await connect(version.webSocketDebuggerUrl);
    const loaded = await browser.send("Extensions.loadUnpacked", { path: DIST });
    if (loaded.error) throw new Error(loaded.error.message);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = await connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: `https://www.twitch.tv/${CHANNEL}` });
    await page.send("Page.bringToFront");

    const probe = async () => {
      const r = await page.send("Runtime.evaluate", { returnByValue: true, expression: PROBE });
      return (r.result && r.result.result && r.result.result.value) || {};
    };

    // Until the break is over, or two minutes.
    const samples = [];
    let overAt = null;
    const started = Date.now();
    while (Date.now() - started < 150000) {
      await wait(500);
      const s = await probe();
      s.at = (Date.now() - started) / 1000;
      samples.push(s);
      if (overAt === null && samples.length % 4 === 0) {
        const log = await engineLog(PORT);
        if (!log.some((l) => l.startsWith(">> AD")) && s.at > 25) break; // no break this time
        if (log.some((l) => l.includes("back to live"))) overAt = s.at;
      }
      if (overAt !== null && s.at - overAt > 30) break;
    }

    const log = await engineLog(PORT);
    if (process.env.VERBOSE) {
      for (const l of log) console.log(`     log: ${l}`);
      const last = samples[samples.length - 1] || {};
      console.log(`     last sample: t=${last.t} at=${last.at}`);
    }
    if (overAt === null) {
      console.log(`run ${n}: no ad break ended within the run — ${log.some((l) => l.startsWith(">> AD")) ? "break still running" : "no break"}`);
      return null;
    }

    // The log is written to storage every 3 s and read every 2: the end is
    // known to five seconds, so the watch starts that much earlier.
    let stall = 0;
    let stallAt = null;
    let lastMove = null;
    let lastT = null;
    for (const s of samples.filter((x) => x.at > overAt - 6)) {
      if (s.t !== lastT) {
        lastT = s.t;
        lastMove = s.at;
      } else if (lastMove !== null && s.at - lastMove > stall) {
        stall = s.at - lastMove;
        stallAt = lastMove - overAt;
      }
    }

    const joins = log.filter((l) => l.includes("original feed")).map((l) => (l.match(/joins at ([-+0-9.]+s)/) || [])[1] || "?");
    const hidden = samples.some((s) => s.visible === false);
    const errors = samples.filter((s) => s.at > overAt - 6 && s.error).map((s) => s.error);
    console.log(
      `run ${n}: join ${joins.join(", ") || "—"} | longest stall ${stall.toFixed(1)}s` +
        `${stallAt === null ? "" : ` (from ${stallAt >= 0 ? "+" : ""}${stallAt.toFixed(1)}s vs. end seen)`}` +
        `${stall > STALL_LIMIT ? "  STALL" : ""}${errors.length ? ` | VIDEO ERROR ${errors[0]}` : ""}` +
        `${hidden ? " | TAB HIDDEN" : ""}`,
    );
    return { stall, hidden, error: errors.length > 0 };
  } finally {
    chrome.kill();
    await wait(800);
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (!CHANNEL) throw new Error("usage: node tests/breakend.mjs <live channel> [runs]");
if (!CHROME) throw new Error("Chrome not found — set CHROME_PATH to its executable");
if (!existsSync(DIST)) throw new Error("extension not built — run: node build.mjs");

const results = [];
for (let n = 1; n <= RUNS; n += 1) {
  try {
    results.push(await run(n));
  } catch (e) {
    console.log(`run ${n}: FAILED ${e.message}`);
  }
}
const seen = results.filter(Boolean);
if (!seen.length) {
  console.log("No break ended in any run: nothing can be concluded.");
  process.exitCode = 1;
} else if (seen.some((r) => r.stall > STALL_LIMIT || r.error)) {
  console.log("The return to live broke the picture.");
  process.exitCode = 1;
} else {
  console.log(`OK — ${seen.length} return(s) to live, picture never stopped.`);
}
