/**
 * Which backup sources are actually worth trying, learned from what happened.
 *
 * The candidate list in `stream.js` is a measurement taken at one point in
 * time, and Twitch moves: a `playerType` that returns a clean feed today can be
 * stitched permanently next month, and a new one can start working. A fixed
 * order means the dead ones keep being asked first, for ever.
 *
 * The engine already produces the evidence — every search reports, for each
 * candidate, whether it came back usable. It was simply thrown away: the record
 * lived in the player's worker, which is destroyed on every reload. Here it is
 * kept, per channel, and turned into an order.
 *
 * Two properties matter more than the exact arithmetic:
 *
 * 1. A candidate never tried must not be buried. It scores as an unknown, which
 *    places it above the proven failures and below the proven successes.
 * 2. Evidence must expire. Counts are halved once they pass a cap, so a month
 *    of old verdicts cannot outvote what happened this week.
 *
 * Pure module: no storage, no clock of its own.
 */

/** Global bucket, used as the prior for a channel with no history. */
export const ANY_CHANNEL = "*";

/** Past this many observations for one candidate, counts are halved. */
export const COUNT_CAP = 24;

/**
 * Weight of the prior, in observations.
 *
 * Four means a candidate has to fail about four times on this channel before
 * the channel's own evidence outweighs its reputation elsewhere — long enough
 * to ride out one bad evening, short enough to react within a session.
 */
export const PRIOR_WEIGHT = 4;

/** Channels untouched for this long are forgotten. */
export const CHANNEL_TTL = 60 * 60 * 24 * 30;

/** Upper bound on remembered channels, oldest dropped first. */
export const MAX_CHANNELS = 60;

export function emptyRanking() {
  return {};
}

/**
 * Copy a channel's bucket before writing to it.
 *
 * The record handed in belongs to the caller: a shallow spread would leave the
 * nested counters shared, and folding a search would silently rewrite history
 * the caller still holds.
 */
function detach(ranking, channel) {
  const current = ranking[channel] || { at: 0, sources: {} };
  const sources = {};
  for (const [label, entry] of Object.entries(current.sources)) {
    sources[label] = { ok: entry.ok, ko: entry.ko };
  }
  ranking[channel] = { at: current.at, sources };
  return ranking[channel];
}

function record(bucket, label) {
  if (!bucket.sources[label]) bucket.sources[label] = { ok: 0, ko: 0 };
  return bucket.sources[label];
}

/** Observed success rate, or 0.5 when nothing is known. */
function rate(entry) {
  if (!entry) return 0.5;
  const total = entry.ok + entry.ko;
  return total > 0 ? entry.ok / total : 0.5;
}

/**
 * Score a candidate for one channel: its own record, pulled towards how it
 * behaves everywhere else.
 *
 * This is what makes the first visit to a new channel useful rather than blind
 * — a source that is stitched on every channel already known starts last there
 * too.
 */
export function scoreFor(ranking, channel, label) {
  const prior = rate((ranking[ANY_CHANNEL] || { sources: {} }).sources[label]);
  const own = (ranking[channel] || { sources: {} }).sources[label];
  const ok = own ? own.ok : 0;
  const ko = own ? own.ko : 0;
  return (ok + prior * PRIOR_WEIGHT) / (ok + ko + PRIOR_WEIGHT);
}

/**
 * Fold one search into the record.
 *
 * `outcomes` is `[[label, usable], …]` for every candidate tried, not only the
 * ones that failed before the winner: a candidate that would also have worked
 * is evidence too, and ignoring it would slowly bury everything but the first
 * entry in the list.
 */
export function recordOutcomes(ranking, channel, outcomes, at = 0) {
  const next = { ...ranking };
  const name = String(channel || "").toLowerCase();
  if (!name || !Array.isArray(outcomes) || !outcomes.length) return next;

  for (const scope of [name, ANY_CHANNEL]) {
    const bucket = detach(next, scope);
    bucket.at = at;
    for (const [label, usable] of outcomes) {
      if (typeof label !== "string" || !label) continue;
      const entry = record(bucket, label);
      if (usable) entry.ok += 1;
      else entry.ko += 1;
      // Rolling window: halving keeps the ratio and forgets the distant past.
      if (entry.ok + entry.ko > COUNT_CAP) {
        entry.ok = Math.round(entry.ok / 2);
        entry.ko = Math.round(entry.ko / 2);
      }
    }
  }
  return next;
}

/**
 * Order candidate labels for a channel, best first.
 *
 * Ties keep the order they were given, so the hand-picked list stays the
 * tie-breaker for everything not yet distinguished by evidence.
 */
export function orderLabels(labels, ranking, channel) {
  const name = String(channel || "").toLowerCase();
  return labels
    .map((label, index) => ({ label, index, score: scoreFor(ranking, name, label) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.label);
}

/** Forget stale and excess channels. The global bucket is never dropped. */
export function pruneRanking(ranking, at = 0) {
  const entries = Object.entries(ranking).filter(([channel]) => channel !== ANY_CHANNEL);
  const fresh = entries.filter(([, value]) => at - (value.at || 0) < CHANNEL_TTL);
  const kept = fresh
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, MAX_CHANNELS);

  const next = Object.fromEntries(kept);
  if (ranking[ANY_CHANNEL]) next[ANY_CHANNEL] = ranking[ANY_CHANNEL];
  return next;
}
