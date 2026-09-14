/**
 * Bridge between the page and the extension.
 *
 * The hook lives in the MAIN world so it can replace `Worker`, and therefore has
 * no access to `chrome.*`. This script lives in the ISOLATED world, where
 * `chrome.runtime` exists but `window.Worker` is the isolated one. Each does
 * what the other cannot; they talk over `postMessage`.
 */

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
  window.postMessage(message, window.location.origin);
});
