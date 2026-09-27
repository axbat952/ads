/**
 * Does the player actually play, with the extension loaded?
 *
 *     node tests/playback.mjs <live channel>
 *
 * The one check none of the others make. The offline tests prove decisions,
 * `switch.mjs` proves the hook installs and stands down — neither watches a
 * picture move. This loads a real channel twice, without the extension and
 * with it, and samples `currentTime` three times: a player that works advances
 * between samples.
 *
 * It exists because a change that passed every other test — rewriting the
 * player's own token request to `popout` — stopped the player from ever
 * starting. Only a bisection like this one found it.
 *
 * `--autoplay-policy=no-user-gesture-required` is what makes a fresh profile
 * start at all; without it no arm plays and the comparison means nothing.
 *
 * Needs a channel that is live right now. Exit code 1 if either arm fails to
 * play.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PROFILE = join(ROOT, ".smoke-profile");
const PORT = 9339;
const CHANNEL = process.argv[2];

/** Chrome location, overridable with CHROME_PATH for other systems. */
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const ARMS = [
  ["without the extension", null],
  ["with the extension", DIST],
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url, onEvent = () => {}) {
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
        return;
      }
      onEvent(m);
    });
  });
}

async function arm(name, dist) {
  rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--enable-unsafe-extension-debugging", "--no-first-run",
    "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ], { stdio: "ignore" });

  const lines = [];
  try {
    let version;
    for (let i = 0; i < 40 && !version; i += 1) {
      await wait(500);
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    const browser = await connect(version.webSocketDebuggerUrl);
    if (dist) {
      const loaded = await browser.send("Extensions.loadUnpacked", { path: dist });
      if (loaded.error) throw new Error(loaded.error.message);
    }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = await connect(list.find((t) => t.type === "page").webSocketDebuggerUrl, (m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        const text = (m.params.args || [])
          .map((a) => (a.value === undefined ? a.description || "" : String(a.value)))
          .join(" ");
        if (text.includes("twitch-ads-remove")) lines.push(text.replace("[twitch-ads-remove] ", ""));
      }
    });
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: `https://www.twitch.tv/${CHANNEL}` });
    // In front, and kept there. A tab that starts hidden never starts playing,
    // extension or not — and which of two successively launched windows gets
    // the focus is up to the desktop. Left to chance, it produced "regressions"
    // that were only the second window opening behind the first.
    await page.send("Page.bringToFront");

    const sample = async () => {
      const r = await page.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          let best = null, area = -1;
          for (const v of document.querySelectorAll("video")) {
            const b = v.getBoundingClientRect();
            if (b.width * b.height > area) { area = b.width * b.height; best = v; }
          }
          return best ? Math.round(best.currentTime * 10) / 10 : null;
        })()`,
      });
      return r.result.result.value;
    };
    const visible = async () => {
      const r = await page.send("Runtime.evaluate", {
        returnByValue: true,
        expression: "document.visibilityState",
      });
      return r.result.result.value === "visible";
    };

    const times = [];
    for (const at of [10, 20, 30]) {
      await wait((at - (times.length ? [10, 20, 30][times.length - 1] : 0)) * 1000);
      times.push(await sample());
    }
    const moving = times[2] !== null && times[2] > (times[1] ?? 0) && times[1] > (times[0] ?? -1);
    if (!(await visible())) {
      console.log(`--- ${name} --- INCONCLUSIVE: the tab ended up hidden`);
      return null;
    }
    console.log(`--- ${name} ---`);
    console.log(`   currentTime at 10s/20s/30s: ${times.join(" / ")}   ${moving ? "PLAYING" : "NOT PLAYING"}`);
    for (const l of lines.slice(0, 12)) console.log(`     ${l}`);
    return moving;
  } finally {
    chrome.kill();
    await wait(800);
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (!CHANNEL) throw new Error("usage: node tests/playback.mjs <live channel>");
if (!CHROME) throw new Error("Chrome not found — set CHROME_PATH to its executable");
if (!existsSync(DIST)) throw new Error("extension not built — run: node build.mjs");

const results = [];
for (const [name, dist] of ARMS) {
  try {
    results.push([name, await arm(name, dist)]);
  } catch (e) {
    console.log(`--- ${name} --- FAILED: ${e.message}`);
    results.push([name, false]);
  }
}

console.log("");
const [control, subject] = results;
if (control[1] === null || subject[1] === null) {
  console.log("A tab was hidden during the run: nothing can be concluded. Run it again.");
  process.exitCode = 1;
} else if (!control[1]) {
  console.log("The player does not start even without the extension: the channel is");
  console.log("probably offline or behind a gate. Nothing can be concluded.");
  process.exitCode = 1;
} else if (!subject[1]) {
  console.log("REGRESSION — the player plays without the extension and not with it.");
  process.exitCode = 1;
} else {
  console.log("OK — the player plays with the extension loaded.");
}
