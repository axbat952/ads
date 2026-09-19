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
  countSegments,
  hasAdMarkers,
  isAdBreak,
  markDiscontinuity,
  parseMedia,
  parseVariants,
  qualityLabel,
  readMediaSequence,
  rollType,
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
} from "./stream.js";

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
        failedTypes: null, // Map(label -> timestamp)
        blockedUntil: 0,
        failures: 0,
        strippingSince: 0,
        stripWarned: false,
        letThroughWarned: false,
        counted: null, // {channel, letThrough}
        sequenceOffset: 0,
        lastSequence: -1,
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
    state.counted = null;
    state.blockedUntil = 0;
    // New break, new chance: start again from a short back-off.
    state.failures = 0;
  }

  // -- session-wide state -------------------------------------------------
  let currentChannel = "";
  let cleanMaster = null; // {channel, label, master, obtainedAt}
  const tally = new Map(); // channel -> [blocked, letThrough]

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
  let adTimeTotal = 0;
  let lastTick = null;
  const sessionStart = now();

  let lastReload = -Infinity;
  let reloadsThisBreak = 0;
  /** True while waiting to see whether a reload achieved anything. */
  let watchingReload = false;

  function log(level, message) {
    onEvent({ type: "log", level, message });
  }

  function candidates() {
    return opt.lowQuality ? [...BACKUP_CANDIDATES, ...LOW_QUALITY_CANDIDATES] : BACKUP_CANDIDATES;
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

  /**
   * Keep the per-channel tally: one entry per break and per URL.
   *
   * A break can change verdict along the way — let through at first, then
   * replaced once a clean feed is found. Counting both would make the table show
   * more events than there were breaks, so the previous verdict is corrected.
   */
  function count(url, letThrough) {
    const state = stateOf(url);
    const channel = (state.variant && state.variant.channel) || currentChannel;
    if (!channel) return;

    const before = state.counted;
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
    state.counted = { channel, letThrough };
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
      out = markDiscontinuity(out);
      state.serving = source;
      state.sequenceOffset = state.lastSequence >= 0 ? state.lastSequence + 1 - sourceSequence : 0;
      log("info", `switched source -> ${source.startsWith("backup:") ? "replacement feed" : "original feed"} (discontinuity flagged)`);
    }

    const served = sourceSequence + state.sequenceOffset;
    if (state.sequenceOffset !== 0) out = writeMediaSequence(out, served);
    state.lastSequence = Math.max(state.lastSequence, served + Math.max(0, countSegments(body) - 1));
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
    watchingReload = true;
    log("warning", `player reload requested (${reason})`);
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
      state.failures += 1;
      const wait = backoffAfter(state.failures);
      state.blockedUntil = now() + wait;
      log("warning", `no clean feed for ${channel} (retry in ${wait}s): ${result.attempts.map(([l, r]) => `${l} (${r})`).join(", ")}`);
      onEvent({ type: "search", channel, found: false, attempts: result.attempts });
      return null;
    }

    const feed = result.stream;
    state.failures = 0;
    cleanMaster = { channel, label: feed.playerType, master: feed.master, obtainedAt: now() };
    state.backup = {
      url: feed.mediaUrl,
      label: feed.playerType,
      obtainedAt: now(),
      quality: feed.quality,
    };
    log("info", `clean feed found via ${feed.playerType} in ${counters.lastSearchMs}ms (${feed.quality})`);
    onEvent({ type: "search", channel, found: true, label: feed.playerType, quality: feed.quality });
    return feed;
  }

  /** Deduplicate searches: the player polls several renditions at once. */
  function startSearch(url) {
    if (searches.has(url)) return searches.get(url);
    if (now() < stateOf(url).blockedUntil) return null;
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
      if (!state.failedTypes) state.failedTypes = new Map();
      state.failedTypes.set(entry.label, now());
      log("info", `replacement feed caught by ads (playerType=${entry.label})`);
      return null;
    }

    state.strippingSince = 0;
    state.stripWarned = false;
    count(url, false);
    counters.swaps += 1;
    if (watchingReload) {
      counters.usefulReloads += 1;
      watchingReload = false;
    }
    onEvent({ type: "swap", label: entry.label, quality: entry.quality });
    return serve(url, body, `backup:${entry.url}`);
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
      counters.adsLetThrough += 1;
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

    if (isInBreak && !wasInBreak) {
      counters.breaks += 1;
      reloadsThisBreak = 0;
      const first = playlist.adBreaks[0];
      lastBreak = {
        at: now(),
        // `roll`, never `type`: two names for the same thing once silently
        // overwrote the event type.
        roll: rollType(playlist) || "?",
        duration: first ? first.duration : 0,
        spots: first ? first.podLength : 0,
      };
      log("warning", `>> AD #${counters.breaks} (${lastBreak.roll}, ${Math.round(lastBreak.duration)}s, pod=${lastBreak.spots})`);
      onEvent({ type: "break", roll: lastBreak.roll, duration: lastBreak.duration, spots: lastBreak.spots });
    } else if (wasInBreak && !isInBreak) {
      log("info", "<< ad break over — back to live");
      endOfBreak(state);
      // Live came back on its own; the reload, if any, may have nothing to do
      // with it, so stop watching.
      watchingReload = false;
      onEvent({ type: "breakOver" });
    }

    // Cumulated ad time. Only URLs the player still polls are considered:
    // otherwise one abandoned mid-break would stay flagged forever and keep the
    // counter running.
    const t = now();
    if (lastTick !== null && live().some((u) => stateOf(u).inBreak)) {
      adTimeTotal += t - lastTick;
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
    opt.block = on !== false;
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
    // Channel change: what we knew about the previous one no longer applies.
    cleanMaster = null;
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

  return { onMaster, onMedia, setChannel, setEnabled, stats, options: opt };
}
