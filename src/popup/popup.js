/**
 * Popup rendering: the whole state of the tool on one screen.
 *
 * No logic here — that lives in `lib/view.js`, which is tested outside the
 * browser. This file only puts the result in the DOM.
 */

import { breakCountdown, channelTally, lastBreakLine, status, tiles } from "../lib/view.js";

const $ = (id) => document.getElementById(id);

/** Authoritative switch, shared with the service worker and the content script. */
const ENABLED_KEY = "twitch-ads-remove-enabled";

function renderTiles(stats) {
  const grid = $("grid");
  grid.replaceChildren();
  for (const [value, label, note] of tiles(stats)) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const v = document.createElement("div");
    v.className = "value";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    const n = document.createElement("div");
    n.className = "note";
    n.textContent = note;
    tile.append(v, l, n);
    grid.append(tile);
  }
}

function renderTally(stats) {
  const host = $("tally");
  host.replaceChildren();
  const rows = channelTally(stats);
  if (!rows.length) return;

  const box = document.createElement("div");
  box.className = "tally";
  const title = document.createElement("div");
  title.className = "tally-title";
  title.textContent = "By channel";

  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const name of ["channel", "blocked", "let through"]) {
    const th = document.createElement("th");
    th.textContent = name;
    head.append(th);
  }
  table.append(head);

  for (const [channel, blocked, letThrough] of rows) {
    const tr = document.createElement("tr");
    const cells = [
      [channel, ""],
      [String(blocked), "#00b686"],
      [String(letThrough), letThrough ? "#f5a623" : "#adadb8"],
    ];
    for (const [text, colour] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (colour) td.style.color = colour;
      tr.append(td);
    }
    table.append(tr);
  }

  box.append(title, table);
  host.append(box);
}

function renderLog(log) {
  const time = (at) => new Date(at * 1000).toLocaleTimeString("en-GB");
  $("log").textContent = log.length
    ? log.map((l) => `${time(l.at)}  ${l.level.padEnd(7)} ${l.message}`).join("\n")
    : "Nothing to report yet.";
}

function renderCountdown(stats) {
  const zone = $("countdown");
  const countdown = breakCountdown(stats);
  if (!countdown) {
    zone.hidden = true;
    return;
  }
  zone.hidden = false;
  $("countdown-text").textContent = countdown.text;
  $("countdown-detail").textContent = countdown.detail || "";
  $("countdown-bar").style.width = `${Math.round(countdown.fraction * 100)}%`;
}

/**
 * Reflect the switch, and say what a change still needs.
 *
 * Switching off applies to open tabs immediately. Switching on cannot: the
 * player builds its worker once, at page load, so a tab opened while off has
 * nothing to hook into. Rather than reload the user's tabs behind their back,
 * the popup says so.
 */
function renderSwitch(enabled, changedTo) {
  $("enabled").checked = enabled;
  $("enabled-label").textContent = enabled ? "On" : "Off";

  const hint = $("hint");
  if (changedTo === true) {
    hint.hidden = false;
    hint.textContent = "Switched on. Reload the Twitch tab to hook the player.";
  } else if (changedTo === false) {
    hint.hidden = false;
    hint.textContent = "Switched off. The player is untouched from now on.";
  } else {
    hint.hidden = true;
  }
}

function render({ stats, log }) {
  const { title, detail, colour } = status(stats);
  $("channel").textContent = stats.channel || "—";
  $("status-title").textContent = title;
  $("status-detail").textContent = detail;
  const dot = $("dot");
  dot.style.background = colour;
  dot.style.boxShadow = `0 0 0 4px ${colour}22`;
  renderCountdown(stats);
  renderTiles(stats);
  renderTally(stats);
  $("last-break").textContent = lastBreakLine(stats);
  renderLog(log || []);
}

async function refresh() {
  try {
    const response = await chrome.runtime.sendMessage({ source: "ads-remove-popup", type: "stats" });
    if (response) render(response);
  } catch {
    /* service worker waking up: the next tick will do */
  }
}

$("enabled").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  renderSwitch(enabled, enabled);
  // Written straight to storage: the service worker and every content script
  // listen for the change, so there is no message to route and nothing to keep
  // in step by hand.
  try {
    await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
  } catch {
    renderSwitch(!enabled);
  }
  refresh();
});

$("log-toggle").addEventListener("click", () => {
  const log = $("log");
  log.hidden = !log.hidden;
});

$("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ source: "ads-remove-popup", type: "reset" });
  refresh();
});

chrome.storage.local
  .get(ENABLED_KEY)
  .then((stored) => renderSwitch(stored[ENABLED_KEY] !== false))
  .catch(() => {});

refresh();
setInterval(refresh, 1000);
