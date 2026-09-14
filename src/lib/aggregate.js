/**
 * Aggregating telemetry from several player workers.
 *
 * The counters live *inside* the player's worker, and that worker is destroyed
 * and recreated on every reload — exactly what this extension deliberately
 * triggers. Without aggregation each reload would reset the numbers and lose the
 * very measurement we are after.
 *
 * Cumulative counters are summed across every worker seen; the instantaneous
 * state is read from the most recent report.
 */

/** Counters that add up from one worker to the next. */
const CUMULATIVE = [
  "breaks",
  "swaps",
  "strippedSegments",
  "adsLetThrough",
  "failedSearches",
  "reloads",
  "usefulReloads",
  "adTimeAvoided",
];

/** Instantaneous state: only meaningful in the latest report. */
const INSTANT = [
  "inBreak",
  "channel",
  "qualityRequested",
  "qualityServed",
  "backupFeeds",
  "frozenFor",
  "adNotBlocked",
  "lastBreak",
  "currentBreak",
  "blocking",
];

/** Running total of workers that have gone away: same additive fields, plus the tally. */
export function emptyTotals() {
  const empty = { tally: {} };
  for (const key of CUMULATIVE) empty[key] = 0;
  return empty;
}

/**
 * Fold workers that stopped reporting into a running total, return the live ones.
 *
 * Without this the report list grows forever — one more worker on every player
 * reload — and the badge countdown walks all of them every second.
 */
export function foldSilent(reports, totals, at, maxSilence = 60) {
  const running = { ...emptyTotals(), ...totals, tally: { ...(totals && totals.tally) } };
  const alive = [];

  for (const report of reports) {
    if (at - report.receivedAt <= maxSilence) {
      alive.push(report);
      continue;
    }
    const stats = report.stats || {};
    for (const key of CUMULATIVE) running[key] += Number(stats[key]) || 0;
    for (const [channel, values] of Object.entries(stats.tally || {})) {
      const entry = running.tally[channel] || [0, 0];
      running.tally[channel] = [entry[0] + (values[0] || 0), entry[1] + (values[1] || 0)];
    }
  }

  return { alive, totals: running };
}

export function emptyStats() {
  const empty = { tally: {}, watchedFor: 0 };
  for (const key of CUMULATIVE) empty[key] = 0;
  empty.inBreak = false;
  empty.channel = "";
  empty.qualityRequested = "";
  empty.qualityServed = [];
  empty.backupFeeds = [];
  empty.frozenFor = 0;
  empty.adNotBlocked = false;
  empty.lastBreak = null;
  empty.currentBreak = null;
  empty.blocking = true;
  return empty;
}

/**
 * @param {Array<{wid: string, receivedAt: number, stats: object}>} reports
 * @param {number} watchedFor seconds of actual playback, tracked outside the workers
 * @param {object|null} totals running total of already-folded workers
 */
export function aggregate(reports, watchedFor = 0, totals = null) {
  const out = emptyStats();
  out.watchedFor = Math.round(watchedFor);

  // The folded total counts even when no live report remains.
  if (totals) {
    for (const key of CUMULATIVE) out[key] += Number(totals[key]) || 0;
    for (const [channel, values] of Object.entries(totals.tally || {})) {
      out.tally[channel] = [values[0] || 0, values[1] || 0];
    }
  }
  if (!reports.length) return out;

  for (const report of reports) {
    const stats = report.stats || {};
    for (const key of CUMULATIVE) out[key] += Number(stats[key]) || 0;
    for (const [channel, values] of Object.entries(stats.tally || {})) {
      const entry = out.tally[channel] || [0, 0];
      entry[0] += Number(values[0]) || 0;
      entry[1] += Number(values[1]) || 0;
      out.tally[channel] = entry;
    }
  }

  // The latest report carries the current state — but only among workers that
  // actually see a stream. The player creates several; the idle one reports an
  // empty channel and, speaking last half the time, would blank the display.
  const active = reports.filter((r) => (r.stats || {}).channel);
  const latest = [...(active.length ? active : reports)].sort((a, b) => b.receivedAt - a.receivedAt)[0];
  for (const key of INSTANT) {
    if (latest.stats && latest.stats[key] !== undefined) out[key] = latest.stats[key];
  }

  return out;
}

/** Badge dot colour, mirroring the popup's status dot. */
export function statusColour(stats) {
  if (!stats.blocking) return "#808080";
  if (stats.adNotBlocked) return "#e63c3c";
  if (stats.frozenFor) return "#e63c3c";
  if (stats.inBreak) return "#ffa500";
  return "#3cc86e";
}

/**
 * Badge text: short, it must fit in four characters.
 *
 * During a break it carries the countdown, so there is no need to open the popup
 * to know whether playback is about to resume.
 */
export function badgeText(stats, at = Date.now() / 1000) {
  if (!stats.blocking) return "";
  if (stats.inBreak) {
    const left = breakRemaining(stats, at);
    return left === null ? "AD" : `${left}s`;
  }
  if (!stats.breaks) return "";
  return String(stats.breaks);
}

/**
 * Announced seconds left, or null when unknown.
 *
 * The duration comes from Twitch's `#EXT-X-DATERANGE`: it is an announcement,
 * not a guarantee. Never goes below zero.
 */
export function breakRemaining(stats, at = Date.now() / 1000) {
  const brk = stats.currentBreak;
  if (!brk || !brk.duration || !brk.startedAt) return null;
  return Math.max(0, Math.ceil(brk.startedAt + brk.duration - at));
}

/** Seconds elapsed since the break started, or null. */
export function breakElapsed(stats, at = Date.now() / 1000) {
  const brk = stats.currentBreak;
  if (!brk || !brk.startedAt) return null;
  return Math.max(0, Math.floor(at - brk.startedAt));
}
