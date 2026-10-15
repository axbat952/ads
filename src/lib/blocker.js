/**
 * Decision engine: what to serve the player for every media playlist it asks for.
 *
 * Three outcomes, in order of preference:
 *
 *   1. serve an ad-free feed obtained for a different `playerType` (a swap);
 *   2. strip the ad segments, when live content remains in the playlist;
 *   3. serve the original playlist untouched, when stripping would empty it —
 *      an empty live playlist sends the player to the streamer's offline screen.
 *
 * Case 3 is where a browser extension can do what a proxy cannot: ask the player
 * to start a new playback session, giving Twitch another chance to hand out an
 * unstitched stream. That reload is instrumented (`reloads`, `usefulReloads`) so
 * its value is measured rather than assumed.
 *
 * Pure module: no network, no DOM. Everything goes through injected functions.
 */

import {
  countPrefetch,
  countSegments,
  dropLeadingSegments,
  hasAdMarkers,
  isAdBreak,
  markDiscontinuity,
  parseMedia,
  parseVariants,
  qualityLabel,
  readMediaSequence,
  rollType,
  segmentTimes,
  stripAds,
  stripHevcVariants,
  writeMediaSequence,
} from "./hls.js";
import {
  BACKUP_CANDIDATES,
  LOW_QUALITY_CANDIDATES,
  candidateLabel,
  cleanStreamFromMaster,
  findCleanStream,
  orderCandidates,
} from "./stream.js";

/**
 * Where to join a new feed so that the player neither replays nor skips.
 *
 * `heldUntil` is the content time the player already holds pictures up to.
 * The join is the first segment that is mostly new; when the new feed is
 * behind and every segment is old, its newest one, which replays the least.
 * Without timestamps on either side there is nothing to align on, and the feed
 * is joined at its start as before.
 *
 * The prefetch segments count. They carry no timestamp, but they follow the
 * last listed one at its own duration, and the player downloads them like any
 * other. Joining among the listed segments only replayed six seconds at the end
 * of every break, every time: the player had prefetched two segments of the
 * replacement, and the original had nothing listed that recent yet — its
 * matching segments were in its own prefetch.
 *
 * `index` counts listed segments first, then prefetch lines. `gap` is the
 * content time between what was held and the joined segment, in seconds:
 * positive skips ahead, negative replays.
 */
export function joinPoint(body, heldUntil) {
  const times = segmentTimes(body);
  if (!times.length || !Number.isFinite(heldUntil)) return { index: 0, gap: NaN };
  const last = times[times.length - 1];
  const candidates = [...times];
  // All but the last. The last prefetch segment is the live edge itself, not
  // yet produced: joining there left the player waiting for it once its own
  // buffer had run out — measured, a stall of one to four seconds on one
  // return in five. The one before it is already on its way.
  for (let k = 1; k < countPrefetch(body); k += 1) {
    candidates.push({ start: last.start + last.duration * 1000 * k, duration: last.duration });
  }
  let index = candidates.findIndex(
    (t) => Number.isFinite(t.start) && t.start + t.duration * 500 > heldUntil,
  );
  if (index === -1) index = candidates.length - 1;
  const start = candidates[index].start;
  if (!Number.isFinite(start)) return { index: 0, gap: NaN };
  return { index, gap: (start - heldUntil) / 1000 };
}

/** How long a backup feed stays valid, in seconds. */
export const BACKUP_TTL = 240;

/**
 * Back-off after a failed search, doubling on each consecutive failure.
 *
 * One search costs up to eleven candidates times three requests. Repeated every
 * five seconds through a long unblockable break, that was in the order of 400
 * requests per minute for an outcome already known.
 */
export const BACKOFF_BASE = 5;
export const BACKOFF_MAX = 60;

export function backoffAfter(failures) {
  return Math.min(BACKOFF_BASE * 2 ** Math.max(0, failures - 1), BACKOFF_MAX);
}

/** Very short cache of a backup body: the player polls faster than Twitch updates. */
export const BACKUP_BODY_TTL = 1.5;
/** Reuse of an already-obtained master for the channel's other renditions. */
export const MASTER_TTL = 12;
/** Past this, warn that the player is sitting on a loading screen. */
export const STRIP_WARN = 12;
/** How long the player's request is held while the first search runs. */
export const FIRST_WAIT = 2.5;
/** A playlist URL not seen for this long is considered abandoned. */
export const URL_STALE = 12;
/** Upper bound on per-URL state, for multi-hour sessions. */
export const MAX_URLS = 64;
/** Past this, a memorised backup body has no chance of being useful. */
export const BODY_STALE = 30;

/**
 * Two renditions crossing into a break within this window are the same break.
 *
 * Measured: the player's playlists enter a break one or two seconds apart.
 */
export const BREAK_GRACE = 10;

/** Never two reloads back to back: that would be an unbearable loop. */
export const RELOAD_COOLDOWN = 25;
/** And never more than two attempts for the same break. */
export const RELOAD_MAX_PER_BREAK = 2;

const DEFAULT_OPTIONS = {
  block: true,
  swap: true,
  dropHevc: true,
  reloadPlayer: true,
  // On by default: the degraded list is only consulted after the nine
  // source-quality candidates, and 480p beats a full ad break.
  lowQuality: true,
};

/**
 * Await a promise, but for at most `seconds`. The timer is cancelled as soon as
 * the promise settles, so no 2.5s timer is left pending on every break.
 */
function raceWithDeadline(promise, seconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

export function createBlocker({
  fetcher,
  now = () => Date.now() / 1000,
  onReload = () => false,
  onEvent = () => {},
  options = {},
} = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };

  /**
   * All state for one playlist URL, in a single record.
   *
   * This used to be thirteen parallel maps on the same key. Each had to be
   * remembered when pruning and when a break ended, and two had already been
   * missed — state outliving what it described. One map makes that impossible.
   */
  const states = new Map();
  /** Backup bodies, keyed by *backup* URL rather than playlist URL. */
  const backupBodies = new Map();
  /** In-flight searches; self-cleaning, so never any residue to prune. */
  const searches = new Map();

  function stateOf(url) {
    let state = states.get(url);
    if (!state) {
      state = {
        seenAt: 0,
        inBreak: false,
        variant: null, // {channel, variant}
        backup: null, // {url, label, obtainedAt, quality}
        serving: "origin",
        failedTypes: null, // Set(label) — caught by ads during this break
        strippingSince: 0,
        stripWarned: false,
        letThroughWarned: false,
        sequenceOffset: 0,
        lastSequence: -1,
        // Served sequence number of the segment the last source switch landed
        // on, for as long as it stays in the window. -1 once it has scrolled
        // out, or before anything was switched.
        discontinuityAt: -1,
        // Content time (ms) up to which the player already holds pictures:
        // the end of the last segment served, prefetch included.
        heldUntil: NaN,
      };
      states.set(url, state);
    }
    return state;
  }

  /** Reset what only makes sense during a break. */
  function endOfBreak(state) {
    state.backup = null;
    state.failedTypes = null;
    state.strippingSince = 0;
    state.stripWarned = false;
    state.letThroughWarned = false;
  }

  // -- session-wide state -------------------------------------------------
  let currentChannel = "";
  let cleanMaster = null; // {channel, label, master, obtainedAt}
  const tally = new Map(); // channel -> [blocked, letThrough]
  /** Verdict already entered in the tally for the current break. */
  let counted = null; // {at, channel, letThrough}
  /** Break for which an ad let through was already counted. */
  let letThroughCountedAt = null;
  /**
   * Back-off after failed searches, per channel.
   *
   * Per URL, each rendition the player polls ran its own searches on its own
   * schedule: two renditions through one unblockable minute made eight failed
   * searches and close to ninety token requests, twice what one would.
   */
  const backoffs = new Map(); // channel -> {failures, until}

  const counters = {
    breaks: 0,
    swaps: 0,
    strippedSegments: 0,
    adsLetThrough: 0,
    failedSearches: 0,
    reloads: 0,
    usefulReloads: 0,
    lastSearchMs: 0,
  };
  let lastBreak = null;
  /**
   * Last time any playlist was seen in a break.
   *
   * A break is new when nothing was in one for a while — not when the last
   * one *started* a while ago. Measured from the start, a rendition joining a
   * break ten seconds in (a quality change, the new playlist of a reload)
   * counted the same break a second time.
   */
  let lastInBreakAt = -Infinity;
  let adTimeTotal = 0;
  let lastTick = null;
  const sessionStart = now();

  let lastReload = -Infinity;
  let reloadsThisBreak = 0;
  /**
   * When the reload being watched was asked for, or 0. A swap within
   * `RELOAD_WATCH` of it is credited to it; one ten minutes later is not.
   */
  let watchingReload = 0;
  const RELOAD_WATCH = 30;

  function log(level, message) {
    onEvent({ type: "log", level, message });
  }

  /**
   * Learned order of the backup sources, supplied by the service worker.
   *
   * It is advice, not a filter: nothing is ever removed from the list, only
   * moved. A candidate the ranking has never heard of stays where the
   * hand-picked list put it.
   */
  let order = [];

  function setRanking(labels) {
    const next = Array.isArray(labels) ? labels.filter((l) => typeof l === "string") : [];
    if (next.join("|") === order.join("|")) return false;
    order = next;
    return true;
  }

  /**
   * Each tier is ordered on its own. Ordered together, a degraded source that
   * happened to score well went ahead of the source-quality ones, and a clean
   * 1080p feed was passed over for 480p.
   */
  function candidates() {
    const best = orderCandidates(BACKUP_CANDIDATES, order);
    return opt.lowQuality ? [...best, ...orderCandidates(LOW_QUALITY_CANDIDATES, order)] : best;
  }

  /** Candidates still worth trying for this URL during the current break. */
  function remainingCandidates(url) {
    const failed = stateOf(url).failedTypes;
    if (!failed || !failed.size) return candidates();
    const left = candidates().filter((c) => !failed.has(candidateLabel(c)));
    // All burned: give them another chance rather than trying nothing.
    return left.length ? left : candidates();
  }

  /**
   * Bound the per-URL state. A multi-hour session goes through many playlist
   * URLs: quality changes, channel changes, CDN rotations.
   */
  function prune() {
    // Backup bodies are keyed by backup URL, so they cannot follow a playlist's
    // fate and are bounded by age instead.
    const t = now();
    for (const [key, body] of backupBodies) {
      if (t - body.at > BODY_STALE) backupBodies.delete(key);
    }

    if (states.size <= MAX_URLS) return;
    const sorted = [...states.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [url] of sorted.slice(0, states.size - MAX_URLS)) states.delete(url);
  }

  /** URLs the player is still actively polling. */
  function live() {
    const t = now();
    return [...states.entries()].filter(([, s]) => t - s.seenAt < URL_STALE).map(([url]) => url);
  }

  function channelOf(url) {
    const state = stateOf(url);
    return (state.variant && state.variant.channel) || currentChannel;
  }

  function backoffFor(channel) {
    let entry = backoffs.get(channel);
    if (!entry) {
      entry = { failures: 0, until: 0 };
      backoffs.set(channel, entry);
    }
    return entry;
  }

  /**
   * Keep the per-channel tally: one entry per break.
   *
   * Per break, not per URL: the player polls two or three renditions, and
   * each one entered the table — one break, three lines. A break can also
   * change verdict along the way — let through at first, then replaced once a
   * clean feed is found — so the previous verdict is corrected rather than
   * added to.
   */
  function count(url, letThrough) {
    const channel = channelOf(url);
    if (!channel || !lastBreak) return;

    const before = counted && counted.at === lastBreak.at ? counted : null;
    if (before && before.channel === channel && before.letThrough === letThrough) return;

    if (before) {
      const previous = tally.get(before.channel);
      if (previous) {
        const column = before.letThrough ? 1 : 0;
        previous[column] = Math.max(0, previous[column] - 1);
      }
    }

    const entry = tally.get(channel) || [0, 0];
    entry[letThrough ? 1 : 0] += 1;
    tally.set(channel, entry);
    counted = { at: lastBreak.at, channel, letThrough };
  }

  /**
   * Serve `body`, flagging any source change to the player.
   *
   * `source` identifies the precise feed, not its category: two successive
   * backup feeds are two Twitch sessions, hence two timelines.
   *
   * It also keeps the media sequence strictly increasing. Every session has its
   * own numbering — a preroll even restarts at 0 — and a live playlist whose
   * sequence goes backwards is stale to a player: it waits instead of playing,
   * which looks like a load that never finishes when the break ends.
   */
  function serve(url, body, source) {
    let out = body;
    const state = stateOf(url);
    const sourceSequence = readMediaSequence(body);

    if (state.serving !== source) {
      state.serving = source;
      // Join the new feed where the old one left off, not at its oldest segment.
      //
      // The new source used to be numbered from the first segment it listed.
      // A Twitch window holds the last fifteen to thirty seconds, so the player
      // went back and played all of it again: at the end of every break, the
      // seconds already watched on the replacement feed came round a second
      // time. The segment to join on is found by content time, which both
      // feeds share; the ones before it are already on screen.
      const join = state.lastSequence >= 0 ? joinPoint(body, state.heldUntil) : { index: 0, gap: NaN };
      state.sequenceOffset =
        state.lastSequence >= 0 ? state.lastSequence + 1 - (sourceSequence + join.index) : 0;
      // Remember WHICH segment the boundary falls on, not just that there is
      // one. The tag used to be written on the single poll where the source
      // changed and never again: on the next poll the window had slid by one,
      // the same segment was still there, and the discontinuity in front of it
      // had vanished. A playlist is a sliding window over a fixed timeline, so
      // a segment that follows a discontinuity must go on following it for as
      // long as it is listed — a player that sees one appear and disappear
      // before the same segment can no longer place what comes after.
      state.discontinuityAt = sourceSequence + join.index + state.sequenceOffset;
      const where = Number.isFinite(join.gap)
        ? `, joins at ${join.gap >= 0 ? "+" : ""}${join.gap.toFixed(1)}s`
        : "";
      log("info", `switched source -> ${source.startsWith("backup:") ? "replacement feed" : "original feed"} (discontinuity flagged${where})`);
    }

    let served = sourceSequence + state.sequenceOffset;

    // Segments ahead of the join are what the player has already shown. They
    // are left out rather than numbered below it: numbers the player already
    // holds would be duplicates at best, and below zero at the very start.
    if (state.discontinuityAt > served) {
      const drop = Math.min(state.discontinuityAt - served, Math.max(0, countSegments(out) - 1));
      out = dropLeadingSegments(out, drop);
      served += drop;
    }

    if (state.discontinuityAt >= 0) {
      const at = state.discontinuityAt - served;
      if (at < 0) state.discontinuityAt = -1; // scrolled out of the window
      else out = markDiscontinuity(out, at);
    }

    if (served !== sourceSequence) out = writeMediaSequence(out, served);
    // The highest number the player can already HOLD, which is not the last
    // listed segment: it has also downloaded the prefetch segments that follow.
    //
    // This is what froze the picture on the return to live. The next source was
    // numbered from the last listed segment, so its first two segments took the
    // numbers of the two the player had just prefetched from the old one. The
    // player kept what it had and dropped the new ones as duplicates — and with
    // them the discontinuity written in front of the first. The next segment
    // then arrived from another session with no discontinuity announced, landed
    // at the wrong place in the timeline, and the picture stopped once the two
    // prefetched segments had played: one to four seconds after the switch,
    // which is exactly the delay every log showed.
    //
    // Numbering past them leaves a gap instead of a collision. A live playlist
    // that jumps forward is one the player skips along; one that reuses numbers
    // is one it cannot follow.
    const listed = Math.max(0, countSegments(out) - 1);
    const prefetched = countPrefetch(out);
    state.lastSequence = Math.max(state.lastSequence, served + listed + prefetched);

    const times = segmentTimes(out);
    const last = times[times.length - 1];
    if (last && Number.isFinite(last.start)) {
      state.heldUntil = last.start + last.duration * 1000 * (1 + prefetched);
    }
    return out;
  }

  /**
   * Ask the player to start a new playback session.
   *
   * Tightly bounded: a reload is visible to the user (the picture restarts), so
   * it must stay rare and only happen where the alternative is a full ad break.
   */
  function requestReload(reason) {
    if (!opt.reloadPlayer) return false;
    const t = now();
    if (t - lastReload < RELOAD_COOLDOWN) return false;
    if (reloadsThisBreak >= RELOAD_MAX_PER_BREAK) return false;
    let accepted = false;
    try {
      accepted = onReload(reason) !== false;
    } catch {
      accepted = false;
    }
    if (!accepted) return false;
    lastReload = t;
    reloadsThisBreak += 1;
    counters.reloads += 1;
    watchingReload = t;
    // No log line here: the page writes one when it actually reloads, with
    // how — two lines for one reload said nothing more than one.
    return true;
  }

  // -- master playlist ----------------------------------------------------

  /**
   * Record the renditions and drop HEVC ones.
   *
   * Recording happens *before* dropping: the player may already sit on an HEVC
   * rendition from an earlier master, and we must recognise it to avoid
   * attempting a substitution there.
   */
  function onMaster(url, text, channel) {
    if (channel) currentChannel = channel;
    const variants = parseVariants(text);
    for (const variant of variants) {
      stateOf(variant.url).variant = { channel: currentChannel, variant };
    }
    onEvent({ type: "master", channel: currentChannel, qualities: variants.map(qualityLabel) });
    if (!opt.dropHevc) return text;
    const { text: out, removed } = stripHevcVariants(text);
    if (removed) {
      log("info", `dropped ${removed} HEVC rendition(s) — no HEVC replacement feed exists`);
    }
    return out;
  }

  // -- searching for a clean feed ----------------------------------------

  async function search(url) {
    const state = stateOf(url);
    const channel = (state.variant && state.variant.channel) || currentChannel;
    const wanted = state.variant ? state.variant.variant : null;
    if (!channel) return null;

    const started = now();

    // A master already obtained covers the channel's other renditions: one
    // request instead of the whole chain for every candidate.
    if (cleanMaster && cleanMaster.channel === channel && started - cleanMaster.obtainedAt < MASTER_TTL) {
      const feed = await cleanStreamFromMaster(channel, cleanMaster.label, cleanMaster.master, fetcher, wanted);
      if (feed) {
        state.backup = {
          url: feed.mediaUrl,
          label: feed.playerType,
          obtainedAt: now(),
          quality: feed.quality,
          // The resolution, beside the label. Two masters name the same
          // rendition differently — one carries `NAME`, the other falls back
          // to the resolution — so the labels cannot be compared.
          resolution: feed.variant ? feed.variant.resolution : "",
        };
        counters.lastSearchMs = Math.round((now() - started) * 1000);
        return feed;
      }
      cleanMaster = null;
    }

    const result = await findCleanStream(channel, fetcher, wanted, remainingCandidates(url));
    counters.lastSearchMs = Math.round((now() - started) * 1000);

    if (!result.stream) {
      counters.failedSearches += 1;
      const backoff = backoffFor(channel);
      backoff.failures += 1;
      const wait = backoffAfter(backoff.failures);
      backoff.until = now() + wait;
      log("warning", `no clean feed for ${channel} (retry in ${wait}s): ${result.attempts.map(([l, r]) => `${l} (${r})`).join(", ")}`);
      onEvent({
        type: "search",
        channel,
        found: false,
        attempts: result.attempts,
        outcomes: result.outcomes,
      });
      return null;
    }

    const feed = result.stream;
    backoffFor(channel).failures = 0;
    cleanMaster = { channel, label: feed.playerType, master: feed.master, obtainedAt: now() };
    state.backup = {
      url: feed.mediaUrl,
      label: feed.playerType,
      obtainedAt: now(),
      quality: feed.quality,
      resolution: feed.variant ? feed.variant.resolution : "",
    };
    log("info", `clean feed found via ${feed.playerType} in ${counters.lastSearchMs}ms (${feed.quality})`);
    // The search returned at the winner; the ranking wants every verdict, so
    // the event waits for the slowest candidate without holding anything up.
    result.allOutcomes.then((outcomes) =>
      onEvent({
        type: "search",
        channel,
        found: true,
        label: feed.playerType,
        quality: feed.quality,
        outcomes,
      }),
    );
    return feed;
  }

  /**
   * One search at a time per URL, and none while the channel is backing off.
   *
   * The in-flight search stays per URL: each rendition needs a feed of its own
   * quality, and the second one derives it from the master the first obtained.
   */
  function startSearch(url) {
    if (searches.has(url)) return searches.get(url);
    if (now() < backoffFor(channelOf(url)).until) return null;
    const promise = search(url)
      .catch(() => null)
      .finally(() => searches.delete(url));
    searches.set(url, promise);
    return promise;
  }

  /** Serve the memorised backup feed, or null if there is none (any more). */
  async function serveBackup(url) {
    const state = stateOf(url);
    const entry = state.backup;
    if (!entry) return null;
    if (now() - entry.obtainedAt > BACKUP_TTL) {
      state.backup = null;
      return null;
    }

    let body;
    const fresh = backupBodies.get(entry.url);
    if (fresh && now() - fresh.at < BACKUP_BODY_TTL) {
      body = fresh.body;
    } else {
      let response;
      try {
        response = await fetcher("GET", entry.url, null, null);
      } catch {
        response = { status: 0, text: "" };
      }
      if (response.status !== 200 || !response.text.startsWith("#EXTM3U")) {
        state.backup = null;
        backupBodies.delete(entry.url);
        return null;
      }
      body = response.text;
      backupBodies.set(entry.url, { at: now(), body });
    }

    if (hasAdMarkers(body)) {
      // The backup feed was caught by the ad server. Drop it, and remember the
      // playerType so it is not offered again during this break.
      state.backup = null;
      backupBodies.delete(entry.url);
      if (!state.failedTypes) state.failedTypes = new Set();
      state.failedTypes.add(entry.label);
      log("info", `replacement feed caught by ads (playerType=${entry.label})`);
      return null;
    }

    state.strippingSince = 0;
    state.stripWarned = false;
    count(url, false);
    if (watchingReload && now() - watchingReload <= RELOAD_WATCH) counters.usefulReloads += 1;
    watchingReload = 0;
    // The ad was let through and is hidden; a clean feed has turned up since.
    // Without saying so, the page kept the live picture covered and muted for
    // the rest of the announced break.
    if (state.letThroughWarned) {
      state.letThroughWarned = false;
      log("info", "clean feed found after all — the ad is replaced");
      onEvent({ type: "adReplaced" });
    }
    // One line per swap, not one per poll. The engine re-serves the backup
    // every two seconds for the length of the break, and reporting each of
    // those buried everything else in the log. Counted the same way.
    const source = `backup:${entry.url}`;
    if (state.serving !== source) {
      counters.swaps += 1;
      const asked = state.variant ? state.variant.variant : null;
      onEvent({
        type: "swap",
        label: entry.label,
        quality: entry.quality,
        // Resolutions, because that is what the player has to splice. Comparing
        // the labels reported a change on every swap when there was none: the
        // two masters name the same rendition differently.
        wanted: asked ? asked.resolution : "",
        served: entry.resolution || "",
      });
    }
    return serve(url, body, source);
  }

  // -- fallback: strip the ad segments ------------------------------------

  function strip(url, text) {
    const state = stateOf(url);
    const { text: cleaned, removed } = stripAds(text);

    // If stripping leaves NO segment — a preroll, or a fully advertised break —
    // we do not serve an empty playlist: the player concludes the stream does
    // not exist and switches to the streamer's offline screen, which needs a
    // manual reload. Serving the ad is the lesser evil; the page hides it.
    if (removed && parseMedia(cleaned).segments.length === 0) {
      // Once per break: this runs on every poll, and one preroll counted as
      // forty-five ads let through.
      const breakAt = lastBreak ? lastBreak.at : null;
      if (letThroughCountedAt !== breakAt) {
        letThroughCountedAt = breakAt;
        counters.adsLetThrough += 1;
      }
      count(url, true);
      if (!state.letThroughWarned) {
        state.letThroughWarned = true;
        log("warning", "no clean feed and stripping would empty the playlist — letting the ad through to keep the player alive");
        onEvent({ type: "adLetThrough", duration: lastBreak ? lastBreak.duration : 0 });
      }
      requestReload("whole playlist is ads");
      return serve(url, text, "origin");
    }

    counters.strippedSegments += removed;

    if (!state.strippingSince) state.strippingSince = now();
    const elapsed = now() - state.strippingSince;
    if (elapsed > STRIP_WARN && !state.stripWarned) {
      state.stripWarned = true;
      log("warning", `no replacement feed for ${Math.round(elapsed)}s — the player is stuck loading`);
      requestReload("player frozen with no replacement feed");
    }

    return serve(url, cleaned, "origin");
  }

  // -- ad break -----------------------------------------------------------

  async function handleBreak(url, text) {
    if (!opt.swap) return strip(url, text);

    const known = stateOf(url).variant;
    if (known && known.variant.isHevc) {
      // No backup feed exists in HEVC: substituting would break the decoder.
      return strip(url, text);
    }

    const cached = await serveBackup(url);
    if (cached !== null) return cached;

    // First poll of the break, nothing cached. Rather than immediately serving a
    // stripped playlist, give the search a short moment (~600ms in practice).
    // The player has buffer and tolerates the wait better than a gap.
    const running = startSearch(url);
    if (running) {
      await raceWithDeadline(running, FIRST_WAIT);
      const found = await serveBackup(url);
      if (found !== null) return found;
    }

    return strip(url, text);
  }

  // -- media playlist -----------------------------------------------------

  async function onMedia(url, text) {
    const state = stateOf(url);
    state.seenAt = now();
    const playlist = parseMedia(text);
    const wasInBreak = state.inBreak;
    const isInBreak = isAdBreak(playlist);

    const previousInBreak = lastInBreakAt;
    if (isInBreak) lastInBreakAt = now();

    if (isInBreak && !wasInBreak) {
      // A break belongs to the channel, not to one playlist URL. The player
      // polls two or three renditions and each one crosses into the break a
      // second or so apart, so counting per URL turned every break into two or
      // three: the log said AD #1, #2, #3 for a single pod, and the tally, the
      // ad time and the per-channel figures were inflated by however many
      // renditions happened to be in play.
      if (!lastBreak || now() - previousInBreak > BREAK_GRACE) {
        counters.breaks += 1;
        // The per-break limits start again here, and only here. Reset on every
        // URL entering a break, they started again on every reload — each one
        // brings new playlist URLs — and the cap of two never held.
        reloadsThisBreak = 0;
        backoffs.clear();
        const first = playlist.adBreaks[0];
        lastBreak = {
          at: now(),
          // `roll`, never `type`: two names for the same thing once silently
          // overwrote the event type.
          roll: rollType(playlist) || "?",
          duration: first ? first.duration : 0,
          spots: first ? first.podLength : 0,
        };
        // Not numbered: the count belongs to this worker, which the player
        // replaces on every reload, so the log said #1 again and again while
        // the badge showed the running total.
        log("warning", `>> AD (${lastBreak.roll}, ${Math.round(lastBreak.duration)}s, pod=${lastBreak.spots})`);
        onEvent({ type: "break", roll: lastBreak.roll, duration: lastBreak.duration, spots: lastBreak.spots });
      }
    } else if (wasInBreak && !isInBreak) {
      endOfBreak(state);
      // Live came back on its own; the reload, if any, may have nothing to do
      // with it, so stop watching.
      watchingReload = 0;
      // Announced once too: the renditions leave the break a few seconds apart,
      // and one of the logs had the same break ending twice, 55s apart.
      // This URL's flag is only cleared further down, so it is excluded here
      // rather than read: what matters is whether any OTHER rendition is still
      // in the break.
      if (live().every((u) => u === url || !stateOf(u).inBreak)) {
        log("info", "<< ad break over — back to live");
        onEvent({ type: "breakOver" });
        // New break, new chance: the next one starts from a short back-off.
        backoffs.clear();
      }
    }

    // Cumulated ad time. Only URLs the player still polls are considered:
    // otherwise one abandoned mid-break would stay flagged forever and keep the
    // counter running.
    // Capped: a tab asleep for five minutes in the middle of a break is not
    // five minutes of ad avoided.
    const t = now();
    if (lastTick !== null && live().some((u) => stateOf(u).inBreak)) {
      adTimeTotal += Math.min(t - lastTick, URL_STALE);
    }
    lastTick = t;

    state.inBreak = isInBreak;
    prune();

    if (isInBreak && opt.block) return handleBreak(url, text);
    // Outside a break we still go through `serve`: it flags the return to the
    // original feed and, above all, keeps the sequence numbering continuous.
    if (opt.block) return serve(url, text, "origin");
    return text;
  }

  /**
   * Turn the engine off, or back on, without rebuilding it.
   *
   * Off is a genuine pass-through: every playlist is handed back exactly as it
   * arrived. The switch exists so that a player misbehaving for any reason can
   * be cleared of suspicion in one click, rather than by uninstalling.
   */
  function setEnabled(on) {
    const was = opt.block;
    opt.block = on !== false;
    // While off, the player was handed Twitch's own numbers. Putting the offset
    // of an earlier break back on top of them sent the sequence backwards —
    // which a player takes for a stale playlist and waits on. Back on, the
    // numbering starts again from what the player has been seeing.
    if (opt.block && !was) {
      for (const state of states.values()) {
        state.serving = "origin";
        state.sequenceOffset = 0;
        state.lastSequence = -1;
        state.discontinuityAt = -1;
        state.heldUntil = NaN;
      }
    }
  }

  /**
   * Channel name supplied by the page.
   *
   * Without it everything depended on having seen the master go by, which the
   * player does not always re-request (cached response, in-app navigation). We
   * then knew about the break without being able to search for a backup feed.
   */
  function setChannel(channel) {
    const clean = String(channel || "").trim().toLowerCase();
    if (!clean || clean === currentChannel) return;
    currentChannel = clean;
    // Channel change: what we knew about the previous one no longer applies —
    // its break included, or a preroll on the new channel within seconds of
    // the old one's break went uncounted.
    cleanMaster = null;
    lastInBreakAt = -Infinity;
  }

  // -- telemetry ----------------------------------------------------------

  function stats() {
    const active = live();
    const t = now();
    const frozen = Math.max(
      0,
      ...active.map((url) => (stateOf(url).strippingSince ? t - stateOf(url).strippingSince : 0)),
    );
    const inBreak = active.filter((url) => stateOf(url).inBreak);

    // The quality the player is asking for *right now*: the most recently seen
    // URL. Walking insertion order picked an arbitrary active rendition.
    let requested = "";
    for (const url of [...active].sort((a, b) => stateOf(b).seenAt - stateOf(a).seenAt)) {
      const known = stateOf(url).variant;
      if (known) {
        requested = qualityLabel(known.variant);
        break;
      }
    }

    const served = new Set();
    const types = new Set();
    for (const url of active) {
      const entry = stateOf(url).backup;
      if (!entry) continue;
      served.add(entry.quality);
      types.add(entry.label);
    }

    return {
      frozenFor: frozen > STRIP_WARN ? Math.round(frozen * 10) / 10 : 0,
      breaks: counters.breaks,
      swaps: counters.swaps,
      strippedSegments: counters.strippedSegments,
      inBreak: inBreak.length > 0,
      backupFeeds: [...types].sort(),
      qualityServed: [...served].sort(),
      watchedFor: Math.round(t - sessionStart),
      adTimeAvoided: Math.round(adTimeTotal),
      qualityRequested: requested,
      failedSearches: counters.failedSearches,
      channel: currentChannel,
      // Whether the player is asking for playlists at all. A worker reports
      // every two seconds whether or not anything plays, and watch time was
      // counted from those reports: an open, idle player page added up hours.
      polling: active.length > 0,
      lastBreak,
      blocking: opt.block,
      adsLetThrough: counters.adsLetThrough,
      tally: Object.fromEntries([...tally.entries()].map(([c, v]) => [c, [...v]])),
      adNotBlocked: inBreak.some((url) => stateOf(url).letThroughWarned),
      reloads: counters.reloads,
      usefulReloads: counters.usefulReloads,
      // Current break, for the countdown: `startedAt` lets the display tick on
      // its own between two reports instead of jumping every 2s.
      currentBreak:
        inBreak.length && lastBreak
          ? {
              roll: lastBreak.roll,
              duration: lastBreak.duration,
              spots: lastBreak.spots,
              startedAt: lastBreak.at,
            }
          : null,
      // Internal state size: the only way to check from outside that a long
      // session stays bounded.
      trackedUrls: states.size,
      cachedBodies: backupBodies.size,
    };
  }

  return { onMaster, onMedia, setChannel, setEnabled, setRanking, stats, options: opt };
}
