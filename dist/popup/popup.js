/**
 * Popup rendering: the whole state of the tool on one screen.
 *
 * No logic here — that lives in `lib/view.js`, which is tested outside the
 * browser. This file only puts the result in the DOM.
 */

import { breakCountdown, channelTally, lastBreakLine, status, tiles } from "../lib/view.js";

const $ = (id) => document.getElementById(id);

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

$("log-toggle").addEventListener("click", () => {
  const log = $("log");
  log.hidden = !log.hidden;
});

$("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ source: "ads-remove-popup", type: "reset" });
  refresh();
});

refresh();
setInterval(refresh, 1000);
