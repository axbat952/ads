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

/**
 * Past this, a report no longer describes the present.
 *
 * Workers report every two seconds. A tab closed in the middle of a break left
 * its last report as the "latest" for ever: the badge counted down a break that
 * had ended an hour before.
 */
export const REPORT_FRESH = 6;

/** Running total of workers that have gone away: same additive fields, plus the tally. */
export function emptyTotals() {
  const empty = { tally: {} };
  for (const key of CUMULATIVE) empty[key] = 0;
  return empty;
}

/**
 * A report's counters, less what was already accounted for.
 *
 * A worker's counters only ever grow from its own start. A `baseline` is the
 * part of them already counted elsewhere — folded into the running total
 * before the worker spoke again, or wiped by a reset — and only what came
 * after it is this report's to add. Without it, a worker silent for a minute
 * and then back was counted twice, and a reset was undone two seconds later
 * by the next report.
 */
export function netStats(report) {
  const stats = (report && report.stats) || {};
  const base = report && report.baseline;
  if (!base) return stats;
  const out = { ...stats, tally: {} };
  for (const key of CUMULATIVE) {
    out[key] = Math.max(0, (Number(stats[key]) || 0) - (Number(base[key]) || 0));
  }
  for (const [channel, values] of Object.entries(stats.tally || {})) {
    const before = (base.tally || {})[channel] || [0, 0];
    out.tally[channel] = [
      Math.max(0, (Number(values[0]) || 0) - (Number(before[0]) || 0)),
      Math.max(0, (Number(values[1]) || 0) - (Number(before[1]) || 0)),
    ];
  }
  return out;
}

/**
 * Fold workers that stopped reporting into a running total, return the live ones.
 *
 * Without this the report list grows forever — one more worker on every player
 * reload — and the badge countdown walks all of them every second.
 *
 * `folded` lists what was folded, raw, so that a worker which turns out to be
 * alive after all can be taken back from where it left off.
 */
export function foldSilent(reports, totals, at, maxSilence = 60) {
  const running = { ...emptyTotals(), ...totals, tally: { ...(totals && totals.tally) } };
  const alive = [];
  const folded = [];

  for (const report of reports) {
    if (at - report.receivedAt <= maxSilence) {
      alive.push(report);
      continue;
    }
    const stats = netStats(report);
    for (const key of CUMULATIVE) running[key] += Number(stats[key]) || 0;
    for (const [channel, values] of Object.entries(stats.tally || {})) {
      const entry = running.tally[channel] || [0, 0];
      running.tally[channel] = [entry[0] + (values[0] || 0), entry[1] + (values[1] || 0)];
    }
    folded.push({ wid: report.wid, stats: report.stats || {} });
  }

  return { alive, totals: running, folded };
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
export function aggregate(reports, watchedFor = 0, totals = null, { at = null } = {}) {
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
    const stats = netStats(report);
    for (const key of CUMULATIVE) out[key] += Number(stats[key]) || 0;
    for (const [channel, values] of Object.entries(stats.tally || {})) {
      const entry = out.tally[channel] || [0, 0];
      entry[0] += Number(values[0]) || 0;
      entry[1] += Number(values[1]) || 0;
      out.tally[channel] = entry;
    }
  }

  // The current state comes from one report — but only among workers that
  // actually see a stream. The player creates several; the idle one reports an
  // empty channel and, speaking last half the time, would blank the display.
  //
  // Given the time, only recent reports count: an old one describes a tab
  // that is gone. And among them, the tab that matters most — one in a break,
  // then one in view — rather than whichever spoke last: two Twitch tabs
  // otherwise took turns, and the panel flipped between them every second.
  const fresh = at === null ? reports : reports.filter((r) => at - r.receivedAt <= REPORT_FRESH);
  const active = fresh.filter((r) => (r.stats || {}).channel);
  const pool = active.length || at !== null ? active : fresh;
  if (!pool.length) return out;
  // Only among fresh reports: without the time, an old report in a break
  // would win over every newer one for ever.
  const rank = (r) => {
    const s = r.stats || {};
    return at === null ? 0 : (s.inBreak ? 2 : 0) + (s.hidden ? 0 : 1);
  };
  const latest = [...pool].sort((a, b) => rank(b) - rank(a) || b.receivedAt - a.receivedAt)[0];
  for (const key of INSTANT) {
    if (latest.stats && latest.stats[key] !== undefined) out[key] = latest.stats[key];
  }

  return out;
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
    // Past its announced length, the break says "AD" rather than "0s": the
    // popup says the announcement was exceeded, and the badge should not
    // contradict it.
    const left = breakRemaining(stats, at);
    return left === null || left === 0 ? "AD" : `${left}s`;
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
