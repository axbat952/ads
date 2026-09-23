/**
 * Extension service worker: session memory and toolbar badge.
 *
 * It decides nothing — decisions live in the player's worker. Its job is to
 * survive reloads: the player's counters restart from zero on every new playback
 * session, and the running total is kept here.
 *
 * State is written to `chrome.storage.local` rather than `session` so it
 * survives both service-worker eviction and closing the browser. The per-channel
 * tally is only useful once accumulated over days.
 */

import { aggregate, badgeText, emptyTotals, foldSilent, statusColour } from "./lib/aggregate.js";
import { emptyRanking, orderLabels, pruneRanking, recordOutcomes } from "./lib/ranking.js";

const STORAGE_KEY = "twitch-ads-remove-state";
/**
 * The off switch, in a key of its own.
 *
 * Separate from the state blob so that `storage.onChanged` fires for the
 * content script only when the switch actually moves, not every time a
 * counter is written.
 */
const ENABLED_KEY = "twitch-ads-remove-enabled";
const LOG_MAX = 300;

/**
 * Past this gap between two reports, nothing was playing: the browser was
 * closed, the tab suspended, or the player stopped.
 */
const TICK_MAX = 10;

const state = {
  /** Seconds during which a stream was actually playing. */
  watched: 0,
  /** Last report received, used to measure `watched` without counting absences. */
  lastTick: 0,
  reports: {}, // key -> {receivedAt, stats} — live workers only
  totals: emptyTotals(), // running total of workers that went away
  log: [], // {at, level, message}
  /**
   * What each backup source is worth, per channel.
   *
   * It lives here rather than in the player's worker because that worker is
   * destroyed on every reload — which is precisely when the lesson of the
   * previous break would have been useful.
   */
  ranking: emptyRanking(),
  /**
   * Every backup source the engine knows about, in its own order.
   *
   * Learned from the searches themselves rather than imported: the engine
   * reports the verdict of every candidate it tried, so the list arrives on its
   * own, and this file does not have to be kept in step with `stream.js`.
   */
  labels: [],
};

/** Merge newly seen labels in, keeping the order the engine uses. */
function learnLabels(outcomes) {
  const seen = new Set(state.labels);
  for (const [label] of outcomes) {
    if (typeof label === "string" && label && !seen.has(label)) {
      seen.add(label);
      state.labels.push(label);
    }
  }
}

let pendingWrite = null;
let enabled = true;

/**
 * Re-read persisted state and *merge* it with whatever already arrived.
 *
 * MV3 requires registering the message listener synchronously, so reports can
 * land while this read is in flight. Assigning over them would replace fresh
 * data with an older snapshot.
 */
async function load() {
  let saved;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, ENABLED_KEY]);
    enabled = stored[ENABLED_KEY] !== false;
    saved = stored && stored[STORAGE_KEY];
  } catch {
    return; // first run
  }
  if (!saved) return;

  state.watched = Math.max(state.watched, Number(saved.watched) || 0);
  state.totals = { ...emptyTotals(), ...saved.totals, tally: { ...(saved.totals || {}).tally } };

  for (const [key, report] of Object.entries(saved.reports || {})) {
    const current = state.reports[key];
    // Most recent wins: a report that arrived meanwhile is fresher than disk.
    if (!current || current.receivedAt < report.receivedAt) state.reports[key] = report;
  }

  state.log = [...(saved.log || []), ...state.log].slice(-LOG_MAX);
  state.ranking = pruneRanking({ ...(saved.ranking || {}), ...state.ranking }, Date.now() / 1000);
  learnLabels((saved.labels || []).map((label) => [label]));
}

/**
 * Learned order for a channel, or nothing when there is nothing to say.
 *
 * Returning nothing leaves the engine on its own hand-picked order, which is
 * the right answer before any evidence exists.
 */
function orderFor(channel) {
  const name = String(channel || "").toLowerCase();
  if (!name || !state.labels.length || !Object.keys(state.ranking).length) return null;
  return orderLabels(state.labels, state.ranking, name);
}

function scheduleWrite() {
  if (pendingWrite) return;
  pendingWrite = setTimeout(() => {
    pendingWrite = null;
    chrome.storage.local.set({ [STORAGE_KEY]: state }).catch(() => {});
  }, 3000);
}

function currentStats() {
  const reports = Object.entries(state.reports).map(([wid, value]) => ({ wid, ...value }));
  // The switch is authoritative over anything the workers last said: when it is
  // off no worker reports at all, so their final snapshot would otherwise keep
  // the dot green for ever.
  return { ...aggregate(reports, state.watched, state.totals), blocking: enabled };
}

/**
 * Count the time a stream was actually playing.
 *
 * Measuring the gap since the service worker started would also count the hours
 * a tab spent asleep. Reports arrive every 2s while a player runs, so their
 * cadence *is* the measurement.
 */
function countWatchTime() {
  const t = Date.now() / 1000;
  if (state.lastTick && t - state.lastTick < TICK_MAX) state.watched += t - state.lastTick;
  state.lastTick = t;
}

/**
 * Drop workers that stopped reporting into the running total.
 *
 * The player creates a new one on every reload; without this the list grows
 * forever and the badge tick walks it every second.
 */
function foldSilentWorkers() {
  const reports = Object.entries(state.reports).map(([wid, value]) => ({ wid, ...value }));
  const { alive, totals } = foldSilent(reports, state.totals, Date.now() / 1000);
  if (alive.length === reports.length) return;
  state.totals = totals;
  state.reports = Object.fromEntries(alive.map((r) => [r.wid, { receivedAt: r.receivedAt, stats: r.stats }]));
}

/**
 * During a break the badge carries the countdown, so it must tick every second
 * while reports only arrive every two. The countdown is recomputed from the
 * break's start time, so it stays correct even if a report is lost.
 */
let badgeTimer = null;

function refreshBadge() {
  const stats = currentStats();
  chrome.action.setBadgeText({ text: badgeText(stats) }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: statusColour(stats) }).catch(() => {});

  if (stats.inBreak && stats.currentBreak && !badgeTimer) {
    badgeTimer = setInterval(refreshBadge, 1000);
  } else if ((!stats.inBreak || !stats.currentBreak) && badgeTimer) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }
}

function note(level, message) {
  state.log.push({ at: Date.now() / 1000, level, message });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message) return undefined;

  if (message.source === "ads-remove-bridge") {
    // Switched off, nothing from a player worker is recorded. One built before
    // the switch moved can still be running, and its reports must not keep the
    // panel alive, the badge counting and the log filling while the user
    // believes the tool is stopped.
    if (!enabled) {
      if (message.type === "stats") respond({ order: [] });
      return message.type === "stats";
    }

    if (message.type === "stats" && message.stats) {
      // Worker ids are per tab, so they are prefixed to keep two Twitch tabs
      // from colliding.
      const key = `${(sender && sender.tab && sender.tab.id) || 0}:${message.wid || "w"}`;
      state.reports[key] = { receivedAt: Date.now() / 1000, stats: message.stats };
      countWatchTime();
      foldSilentWorkers();
      refreshBadge();
      scheduleWrite();
      // The reply carries the learned order back to the page. Answering on the
      // report the page already sends avoids `chrome.tabs` and the host
      // permission it would require.
      respond({ order: orderFor(message.stats.channel) || [] });
      return true;
    } else if (message.type === "event" && message.event) {
      const event = message.event;
      if (event.type === "search" && Array.isArray(event.outcomes) && event.outcomes.length) {
        learnLabels(event.outcomes);
        state.ranking = recordOutcomes(
          state.ranking,
          event.channel,
          event.outcomes,
          Date.now() / 1000,
        );
      }
      const where = (hidden) => (hidden ? "tab hidden" : "tab visible");
      if (event.type === "log") note(event.level || "info", event.message || "");
      else if (event.type === "break") note("warning", `ad break ${event.roll || "?"} ${Math.round(event.duration || 0)}s`);
      else if (event.type === "reloadPerformed") note("warning", `player reload: ${event.reason} (${event.how})`);
      else if (event.type === "error") note("error", `engine error: ${event.message}`);
      // The diagnostics below answer one question between them: when the
      // picture stops, is the extension holding the player, has the player
      // given up, or neither? The console carried them; this log is what gets
      // read after the fact, and it is the one that survives a reload.
      else if (event.type === "pictureStuck") {
        note("error", `picture stuck ${event.seconds}s (${where(event.hidden)})`);
      } else if (event.type === "pictureRecovered") {
        note("info", `picture recovered after ${event.seconds}s`);
      } else if (event.type === "slowHold") {
        note("warning", `playlist held ${(event.ms / 1000).toFixed(1)}s (${where(event.hidden)})`);
      } else if (event.type === "playerStopped") {
        note("warning", `player stopped asking for playlists ${event.after}s ago (${where(event.hidden)})`);
      } else if (event.type === "pollResumed") {
        note("info", `player is asking again, after ${event.after}s`);
      }
      scheduleWrite();
    } else if (message.type === "ready") {
      note("info", "engine installed in the player worker");
    }
    return undefined;
  }

  if (message.source === "ads-remove-popup") {
    if (message.type === "stats") {
      respond({ stats: currentStats(), log: state.log.slice(-120) });
      return true;
    }
    if (message.type === "reset") {
      state.watched = 0;
      state.lastTick = 0;
      state.reports = {};
      state.totals = emptyTotals();
      state.log = [];
      state.ranking = emptyRanking();
      state.labels = [];
      refreshBadge();
      scheduleWrite();
      respond({ ok: true });
      return true;
    }
  }
  return undefined;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ENABLED_KEY]) return;
  enabled = changes[ENABLED_KEY].newValue !== false;
  note("info", enabled ? "switched on" : "switched off");
  refreshBadge();
  scheduleWrite();
});

load().then(refreshBadge);
