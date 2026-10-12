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

import { aggregate, badgeText, emptyTotals, foldSilent } from "./lib/aggregate.js";
import { emptyRanking, orderLabels, pruneRanking, recordOutcomes } from "./lib/ranking.js";
import { status } from "./lib/view.js";

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
  reports: {}, // key -> {receivedAt, stats, baseline?} — live workers only
  totals: emptyTotals(), // running total of workers that went away
  /**
   * Workers folded into `totals`, with the counters they had then.
   *
   * A worker is folded after a minute of silence, but silence is not death: a
   * sleeping laptop, a frozen tab, the switch turned off for a while. When one
   * speaks again it is taken back with what was folded as its baseline, so
   * only what it adds from then on counts — it was counted twice before.
   */
  folded: {}, // key -> {at, stats}
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

  state.folded = { ...(saved.folded || {}), ...state.folded };

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
  return {
    ...aggregate(reports, state.watched, state.totals, { at: Date.now() / 1000 }),
    blocking: enabled,
  };
}

/**
 * Count the time a stream was actually playing.
 *
 * Measuring the gap since the service worker started would also count the hours
 * a tab spent asleep. Reports arrive every 2s while a player runs, so their
 * cadence *is* the measurement.
 */
function countWatchTime(stats) {
  // Only a report from a player that is fetching a stream: every worker
  // reports, playing or not, and an idle player page counted as watching.
  if (!stats || !stats.channel || stats.polling === false) return;
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
  const t = Date.now() / 1000;
  const { alive, totals, folded } = foldSilent(reports, state.totals, t);
  if (alive.length === reports.length) return;
  state.totals = totals;
  state.reports = Object.fromEntries(
    alive.map((r) => [r.wid, { receivedAt: r.receivedAt, stats: r.stats, baseline: r.baseline }]),
  );
  for (const { wid, stats } of folded) state.folded[wid] = { at: t, stats };
  // Bounded: a day is ample for a worker to come back, and the player builds a
  // new one on every reload.
  const kept = Object.entries(state.folded)
    .filter(([, entry]) => t - entry.at < FOLDED_KEEP)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, FOLDED_MAX);
  state.folded = Object.fromEntries(kept);
}

const FOLDED_KEEP = 86400;
const FOLDED_MAX = 100;

/** Record a worker's report, against what was already counted of it. */
function recordReport(key, stats) {
  const previous = state.reports[key];
  let baseline = previous ? previous.baseline : undefined;
  if (!previous && state.folded[key]) {
    baseline = state.folded[key].stats;
    delete state.folded[key];
  }
  state.reports[key] = { receivedAt: Date.now() / 1000, stats, baseline };
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
  // The popup's own colour, from the same function: the badge used to have a
  // palette of its own, orange for a break the popup showed green.
  chrome.action.setBadgeBackgroundColor({ color: status(stats).colour }).catch(() => {});

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
      recordReport(key, message.stats);
      countWatchTime(message.stats);
      foldSilentWorkers();
      refreshBadge();
      scheduleWrite();
      // The reply carries the learned order back to the page. Answering on the
      // report the page already sends avoids `chrome.tabs` and the host
      // permission it would require. Nothing for a worker with no channel:
      // its empty order reached every worker of the page and undid the
      // ranking every two seconds.
      respond(message.stats.channel ? { order: orderFor(message.stats.channel) || [] } : {});
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
      // No line for the `break` event: the engine's own ">> AD" line says the
      // same, and every break was written twice.
      else if (event.type === "reloadPerformed") note("warning", `player reload: ${event.reason} (${event.how})`);
      else if (event.type === "reloadSkipped") note("info", `player reload skipped: ${event.reason} (${event.why})`);
      else if (event.type === "error") note("error", `engine error: ${event.message}`);
      // The diagnostics below answer one question between them: when the
      // picture stops, is the extension holding the player, has the player
      // given up, or neither? The console carried them; this log is what gets
      // read after the fact, and it is the one that survives a reload.
      else if (event.type === "pictureStuck") {
        note(
          "error",
          `picture stuck ${event.seconds}s (${where(event.hidden)}, ${event.videos || 0} video element(s))`,
        );
      } else if (event.type === "pictureRecovered") {
        note(
          "info",
          `picture recovered after ${event.seconds}s${event.by ? ` (${event.by})` : ""} (${where(event.hidden)})`,
        );
      } else if (event.type === "playerNudged") {
        note("warning", `picture stopped ${event.seconds}s — pause/play (${where(event.hidden)})`);
      } else if (event.type === "slowHold") {
        note("warning", `playlist held ${(event.ms / 1000).toFixed(1)}s (${where(event.hidden)})`);
      } else if (event.type === "playerStopped") {
        note("warning", `player stopped asking for playlists ${event.after}s ago (${where(event.hidden)})`);
      } else if (event.type === "qualityChanged") {
        note("warning", `replacement is a different rendition: ${event.wanted} -> ${event.served}`);
      } else if (event.type === "pollResumed") {
        note("info", `player is asking again, after ${event.after}s`);
      }
      scheduleWrite();
    } else if (message.type === "ready") {
      note("info", "engine installed in the player worker");
      scheduleWrite();
    }
    return undefined;
  }

  // The popup waits for the saved state. The service worker is asleep most of
  // the time the popup opens, and answering from the empty memory it wakes up
  // with showed a frame of zeros — and let a reset be merged back over by the
  // read still in flight.
  if (message.source === "ads-remove-popup") {
    if (message.type === "stats") {
      loaded.then(() => respond({ stats: currentStats(), log: state.log.slice(-120) }));
      return true;
    }
    if (message.type === "reset") {
      loaded.then(() => {
        const t = Date.now() / 1000;
        state.watched = 0;
        state.lastTick = 0;
        // Live workers keep their counters, which only grow: what they hold
        // now becomes their baseline. Emptying the list instead let the next
        // report, two seconds later, bring every number back.
        for (const report of Object.values(state.reports)) {
          report.baseline = report.stats;
          report.receivedAt = Math.min(report.receivedAt, t);
        }
        state.totals = emptyTotals();
        state.log = [];
        state.ranking = emptyRanking();
        state.labels = [];
        refreshBadge();
        scheduleWrite();
        respond({ ok: true });
      });
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

const loaded = load().then(refreshBadge);
