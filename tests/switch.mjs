/**
 * The off switch, in a real Chrome.
 *
 *     node tests/switch.mjs
 *
 * The offline tests prove the engine passes playlists through when told to stop.
 * They cannot see the thing that actually went wrong: `window.Worker` stays
 * replaced for the life of the page, and the player builds new workers
 * constantly — on reload, on channel change, on quality change. Each new one
 * used to start on the default, enabled, so switching off silenced only the
 * workers alive at that instant and the next one blocked again.
 *
 * Exit code 1 if any check fails.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("..", import.meta.url)) + "x");
const DIST = join(ROOT, "dist");
const PROFILE = join(ROOT, ".smoke-profile");
const PORT = 9336;

/** Any twitch.tv page: the content scripts run there, no stream needed. */
const PAGE = "https://www.twitch.tv/directory";

/** Chrome location, overridable with CHROME_PATH for other systems. */
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

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

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  if (!CHROME) throw new Error("Chrome not found — set CHROME_PATH to its executable");
  if (!existsSync(DIST)) throw new Error("extension not built — run: node build.mjs");
  rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--enable-unsafe-extension-debugging", "--no-first-run",
    "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });

  try {
    let version;
    for (let i = 0; i < 40 && !version; i += 1) {
      await wait(500);
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    console.log(`Chrome ${version.Browser}\n`);

    const browser = await connect(version.webSocketDebuggerUrl);
    const loaded = await browser.send("Extensions.loadUnpacked", { path: DIST });
    const extensionId = loaded.result.id;

    const lines = [];
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = await connect(list.find((t) => t.type === "page").webSocketDebuggerUrl, (m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        const text = (m.params.args || [])
          .map((a) => (a.value === undefined ? a.description || "" : String(a.value)))
          .join(" ");
        if (text.includes("twitch-ads-remove")) lines.push(text);
      }
    });
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: PAGE });
    await wait(6000);

    const ask = async (expression) => {
      const out = await page.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true,
      });
      return ((out.result || {}).result || {}).value;
    };

    /** Build a worker the way the player does, and see whether ours runs in it. */
    const spawnWorker = async (name) => {
      const before = lines.length;
      await ask(`
        (() => {
          const src = URL.createObjectURL(new Blob(["self.onmessage=()=>{}"],
            { type: "text/javascript" }));
          window.__w_${name} = new Worker(src);
          return true;
        })()
      `);
      await wait(2500);
      return lines.slice(before).some((l) => l.includes("engine installed in the player worker"));
    };

    // --- 1. switched on ----------------------------------------------------
    console.log("1. switch on (default)");
    check("a new worker gets the engine", await spawnWorker("a"));

    // --- 2. flip it off from the popup, as a user would --------------------
    console.log("\n2. switched off from the popup");
    const opened = await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
    });
    await wait(2000);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const popup = await connect(targets.find((t) => t.id === opened.result.targetId).webSocketDebuggerUrl);
    await popup.send("Runtime.enable");
    await popup.send("Runtime.evaluate", {
      expression: `document.getElementById("enabled").click()`,
    });
    await wait(2500);

    const stored = await popup.send("Runtime.evaluate", {
      expression: `chrome.storage.local.get("twitch-ads-remove-enabled")
        .then((s) => String(s["twitch-ads-remove-enabled"]))`,
      awaitPromise: true, returnByValue: true,
    });
    check("the switch is stored as off", stored.result.result.value === "false",
      stored.result.result.value);

    const seen = await popup.send("Runtime.evaluate", {
      expression: `chrome.runtime.sendMessage({ source: "ads-remove-popup", type: "stats" })
        .then((r) => String(r.stats.blocking))`,
      awaitPromise: true, returnByValue: true,
    });
    check("the service worker agrees it is off", seen.result.result.value === "false",
      `blocking=${seen.result.result.value}`);

    check("the open page was told", lines.some((l) => l.includes("switched off")));

    // --- 3. the part the player actually does ------------------------------
    console.log("\n3. a worker created AFTER the switch went off");
    const hooked = await spawnWorker("b");
    check("it must NOT get the engine", !hooked, hooked ? "it did — the switch is cosmetic" : "");

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    chrome.kill();
    await wait(800);
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
});
