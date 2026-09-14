/**
 * Smoke test: real Chrome, extension loaded, a real Twitch stream.
 *
 *     node tests/smoke.mjs [url] [seconds]
 *
 * The unit tests prove the engine decides correctly. They do not prove the one
 * genuinely uncertain thing: that the Worker hook catches the Twitch player's
 * worker, whose shape and creation time are outside our control. This script
 * checks that by reading the page console over CDP — no dependencies,
 * `WebSocket` has been built into Node since v22.
 *
 * Field note: `--load-extension` no longer works (removed from stable Chrome;
 * verified ineffective in 152, including with the former
 * `--disable-features=DisableLoadExtensionCommandLineSwitch` workaround). The
 * current path is the CDP command `Extensions.loadUnpacked`, which requires
 * launching with `--enable-unsafe-extension-debugging`.
 *
 * Output: one verdict per step, exit code 1 if a step is missing.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const PROFILE = join(ROOT, ".smoke-profile");
const PORT = 9333;
const SCREENSHOT = join(ROOT, ".smoke-page.png");
const POPUP = join(ROOT, ".smoke-popup.png");

const TARGET_URL = process.argv[2] || "https://www.twitch.tv/";
const DURATION = Number(process.argv[3] || 45);

/** Chrome location, overridable with CHROME_PATH for other systems. */
const CHROME = [
  process.env.CHROME_PATH,
  // Windows
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(produce, what, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await produce();
      if (value) return value;
    } catch {
      /* not ready yet */
    }
    await wait(500);
  }
  throw new Error(`${what} : rien apres ${(attempts * 500) / 1000} s`);
}

/** Minimal CDP client: request/response plus an event stream. */
function connect(url, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    const send = (method, params) =>
      new Promise((res) => {
        id += 1;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    ws.addEventListener("open", () => resolve({ ws, send }));
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
        return;
      }
      onEvent(message);
    });
  });
}

function texteArgument(arg) {
  if (arg.value !== undefined) return String(arg.value);
  return arg.description || "";
}

async function main() {
  if (!CHROME) throw new Error("Chrome not found — set CHROME_PATH to its executable");
  if (!existsSync(DIST)) throw new Error("extension not built - run: node build.mjs");
  rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      // Without this flag, `Extensions.loadUnpacked` is refused.
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const logLines = [];
  let extensionId = "";
  let capturedBreak = false;
  let capturePopup = async () => {};
  try {
    const version = await waitFor(
      async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(),
      "debugging port",
    );
    console.log(`Chrome ${version.Browser}`);

    const browser = await connect(version.webSocketDebuggerUrl);
    // CONTROL=1: the same scenario without the extension, to tell "our hook
    // breaks playback" apart from "the player does not start in this profile".'
    if (process.env.CONTROL) {
      console.log("CONTROL: extension NOT loaded");
    } else {
      const loaded = await browser.send("Extensions.loadUnpacked", { path: DIST });
      if (loaded.error) throw new Error(`load refused: ${loaded.error.message}`);
      extensionId = loaded.result.id;
      console.log(`Extension loaded: ${extensionId}`);
    }

    // Twitch is opened AFTER loading, so the content script is in place at
    // `document_start`.
    await browser.send("Target.createTarget", { url: TARGET_URL });

    const page = await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      return targets.find((c) => c.type === "page" && c.url.includes("twitch.tv"));
    }, "Twitch tab");

    const { send } = await connect(page.webSocketDebuggerUrl, (message) => {
      if (message.method !== "Runtime.consoleAPICalled") return;
      const line = (message.params.args || []).map(texteArgument).join(" ");
      if (!line.includes("[twitch-ads-remove]")) return;
      logLines.push(line);
      console.log(`   ${line}`);
      // The popup is only interesting if captured DURING a break, so the
      // capture is triggered by the event rather than at a fixed time.
      if (line.includes("ad break ") && !capturedBreak) {
        capturedBreak = true;
        setTimeout(() => {
          capturePopup("during the break").catch((e) => console.log(`   capture failed: ${e.message}`));
        }, 4000);
      }
    });
    await send("Runtime.enable");
    await send("Page.enable");
    // The hook installs at `document_start`, so attaching is necessarily later:
    // reload to start over with the listener in place.
    await send("Page.reload", {});

    // A throwaway profile means a consent banner, which stops playback from
    // starting. We decline: the least intrusive option, and the only one that
    // commits nothing on the user's behalf.
    await wait(6000);
    const click = async (reason, what) => {
      const answer = await send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const boutons = [...document.querySelectorAll("button, [role=button]")];
          const target = boutons.find(b => ${reason}.test((b.innerText || "").trim()));
          if (target) { target.click(); return "clic: " + target.innerText.trim(); }
          return "rien | " + boutons.map(b => (b.innerText || "").trim()).filter(Boolean).slice(0, 8).join(" / ");
        })()`,
      });
      console.log(`   ${what}: ${(answer.result.result || {}).value}`);
    };

    await click("/^(refuser|rejeter|reject|decline|continuer sans)/i", "consent");
    await wait(3000);
    // Some channels sit behind a mature-content warning.
    await click("/commencer a regarder|start watching|^continuer$/i", "content warning");
    await wait(2000);

    // A JavaScript click is not a user gesture, so Chrome's autoplay policy
    // refuses it on a fresh profile. A CDP-synthesised input event is one.
    const box = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const v = document.querySelector("video");
        if (!v) return null;
        const r = v.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
    });
    const centre = (box.result.result || {}).value;
    if (centre) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: centre.x,
          y: centre.y,
          button: "left",
          clickCount: 1,
        });
      }
      console.log(`   user gesture on the player (${centre.x}, ${centre.y})`);
    }

    capturePopup = async (when) => {
      if (!extensionId) return;
      const tab = await browser.send("Target.createTarget", {
        url: `chrome-extension://${extensionId}/popup/popup.html`,
      });
      await wait(2000);
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const view = targets.find((c) => c.url.includes("popup.html"));
      if (view) {
        const { send: sendPopup } = await connect(view.webSocketDebuggerUrl);
        await sendPopup("Page.enable");
        const shot = await sendPopup("Page.captureScreenshot", { format: "png" });
        if (shot.result && shot.result.data) {
          const file = when === "at the end" ? POPUP : POPUP.replace(".png", "-break.png");
          writeFileSync(file, Buffer.from(shot.result.data, "base64"));
          console.log(`   popup (${when}) saved to ${file}`);
        }
        const read = await sendPopup("Runtime.evaluate", {
          returnByValue: true,
          expression: 'document.getElementById("status-title").textContent + " | " + (document.getElementById("countdown").hidden ? "no countdown" : document.getElementById("countdown-text").textContent)',
        });
        console.log(`   popup (${when}): ${(read.result.result || {}).value}`);
      }
      if (tab.result) await browser.send("Target.closeTarget", { targetId: tab.result.targetId });
    };

    console.log(`Watching ${TARGET_URL} for ${DURATION}s...`);
    await wait(DURATION * 1000);

    // Probes independent of the console. `m3u8MainThread` is the telling one:
    // requests issued from a worker do NOT appear in the page's resource
    // timeline, so seeing any would mean the player bypasses the worker.
    const probe = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const v = document.querySelector("video");
        const res = performance.getEntriesByType("resource").map(e => e.name);
        return {
          worker: String(Worker).slice(0, 40),
          video: !!v,
          lecture: v ? Math.round(v.currentTime) : -1,
          pret: v ? v.readyState : -1,
          m3u8Principal: res.filter(n => n.includes(".m3u8")).length,
          usherPrincipal: res.filter(n => n.includes("usher")).length,
          ressources: res.length,
          ttvnw: res.filter(n => /ttvnw|usher|playlist|\.ts/.test(n)).slice(0, 6),
          src: (v && v.src || "").slice(0, 60),
          line: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 160),
        };
      })()`,
    });
    const details = (probe.result && probe.result.result && probe.result.result.value) || {};
    console.log(`   Worker          = ${details.worker}`);
    console.log(`   <video>         = ${details.video} (readyState ${details.ready}, t=${details.playing}s)`);
    console.log(`   .m3u8 main thread = ${details.m3u8MainThread} | usher = ${details.usherMainThread}`);
    console.log(`   ressources=${details.ressources} ttvnw=${JSON.stringify(details.ttvnw)}`);
    console.log(`   video.src = ${details.src}`);
    console.log(`   page : ${details.line}`);
    if (String(details.worker).includes("extends")) logLines.push("[twitch-ads-remove] probe: Worker replaced");
    if (details.lecture > 0) logLines.push("[twitch-ads-remove] probe: playing");

    await capturePopup("at the end");

    // A screenshot beats a truncated `innerText` when the player refuses to
    // start: it shows immediately whether a panel covers the page.
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result && shot.result.data) {
      writeFileSync(SCREENSHOT, Buffer.from(shot.result.data, "base64"));
      console.log(`   screenshot: ${SCREENSHOT}`);
    }
  } finally {
    chrome.kill();
    await wait(1000);
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5 });
  }

  const steps = [
    ["hook injected into the page", logLines.some((l) => l.includes("hook installed"))],
    ["window.Worker replaced", logLines.some((l) => l.includes("probe: Worker replaced"))],
    ["player worker hooked", logLines.some((l) => l.includes("engine installed"))],
    ["playlists intercepted", logLines.some((l) => l.includes("tracking channel"))],
  ];

  console.log("");
  for (const [name, ok] of steps) console.log(`${ok ? "OK  " : "RATE"} ${name}`);
  const count = (reason) => logLines.filter((l) => l.includes(reason)).length;
  console.log(`     coupures rencontrees : ${count("ad break ")}`);
  console.log(`     playlists remplacees : ${count("feed replaced")}`);
  console.log(`     lecteur relance      : ${count("reloading player")}`);

  return steps.every(([, ok]) => ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FAILED: ${error.message}`);
    process.exit(1);
  },
);
