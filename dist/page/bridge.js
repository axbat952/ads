/**
 * Bridge between the page and the extension.
 *
 * The hook lives in the MAIN world so it can replace `Worker`, and therefore has
 * no access to `chrome.*`. This script lives in the ISOLATED world, where
 * `chrome.runtime` exists but `window.Worker` is the isolated one. Each does
 * what the other cannot; they talk over `postMessage`.
 *
 * It also carries the off switch down to the page, and keeps a copy of it in
 * the page's own `localStorage` — the only store the hook can read
 * synchronously, early enough to decide whether to hook at all.
 */

/** Authoritative switch, shared with the popup and the service worker. */
const ENABLED_KEY = "twitch-ads-remove-enabled";

function toPage(message) {
  window.postMessage(message, window.location.origin);
}

/**
 * Publish a switch value to this page.
 *
 * The mirror is written first: it is what the *next* page load reads, and it
 * must be right even if the tab is closed a moment later.
 */
function publishSwitch(enabled) {
  try {
    window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // Site data blocked for twitch.tv. The switch still applies to this page;
    // only the head start on the next load is lost.
  }
  toPage({ source: "ads-remove-extension", type: "setEnabled", enabled });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "ads-remove-page") return;
  try {
    chrome.runtime.sendMessage({ ...data, source: "ads-remove-bridge" });
  } catch {
    // Extension reloaded mid-session: the context is invalidated and there is
    // nothing to repair from the page. Blocking continues; only telemetry stops.
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "ads-remove-extension") return;
  toPage(message);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ENABLED_KEY]) return;
  publishSwitch(changes[ENABLED_KEY].newValue !== false);
});

// Initial sync. This resolves after the hook has already decided, which is
// precisely why the mirror exists; it matters when the two disagree, for
// instance on the first load after the switch was flipped from another tab.
chrome.storage.local
  .get(ENABLED_KEY)
  .then((stored) => publishSwitch(stored[ENABLED_KEY] !== false))
  .catch(() => {});
