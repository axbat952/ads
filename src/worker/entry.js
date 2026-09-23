/**
 * The part that runs *inside* the Twitch player's worker.
 *
 * The player does not fetch its playlists from the main thread: it uses the
 * `amazon-ivs-wasmworker` worker. Hooking `window.fetch` therefore sees nothing,
 * which is why `page/hook.js` rebuilds the worker blob with this code prepended.
 *
 * Two things learned from real traffic, both invisible offline:
 *
 * 1. Classifying by URL does not work. The master is served from
 *    `/api/v2/channel/hls/<channel>.m3u8`, and media playlists from
 *    `/v1/playlist/<blob>` — with no `.m3u8` extension. Filtering on `.m3u8`
 *    lets through exactly what needs intercepting, so classification is by
 *    content.
 * 2. Never post to the worker's own message channel. Sending it an unknown
 *    message freezes the player on an endless loading screen. All communication
 *    goes through a private `BroadcastChannel` whose name the page injects.
 */

import { createBlocker } from "../lib/blocker.js";
import { isMaster } from "../lib/hls.js";

/** Master playlist: both `/api/channel/hls/` and `/api/v2/channel/hls/`. */
const MASTER_RE = /\/channel\/hls\/([^./?]+)/;

/** Worth reading: both playlist families, never segments. */
const PLAYLIST_RE = /\/channel\/hls\/|\/v1\/playlist\/|\.m3u8/;
const SEGMENT_RE = /\/v1\/segment\//;

const HLS_MIME = "application/vnd.apple.mpegurl";

/** How often telemetry is broadcast. */
const TELEMETRY_MS = 2000;

/**
 * Upper bound on a single backup request.
 *
 * Nothing else bounds them. The search runs every candidate through
 * `Promise.all`, so one connection that never answers holds the whole search,
 * and the player's own playlist request is waiting behind it — its buffer
 * drains and the picture stops.
 *
 * The engine's own guard, `FIRST_WAIT`, is a `setTimeout`, and Chrome throttles
 * timers in a hidden page: in a background tab that guard can stretch far past
 * the 2.5s it promises. This one is enforced by the platform, not by a timer we
 * own, so it holds wherever the tab is. A full chain of three requests measures
 * about 1.3s in practice, which leaves ample headroom.
 */
export const REQUEST_TIMEOUT_MS = 4000;

/**
 * Past this, the hook held the player's own request long enough to matter.
 *
 * The player polls every two seconds and has only a few seconds of buffer, so
 * anything above this is worth a line in the log — it is the one measurement
 * that separates "the extension is holding the response" from "the stream
 * stopped for its own reasons", and the log said nothing at all about a freeze
 * that only happened in a background tab.
 */
export const HOLD_WARN_MS = 3000;

/** `AbortSignal.timeout` where it exists, nothing where it does not. */
function deadline(ms = REQUEST_TIMEOUT_MS) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

/** Channel name, taken from the master playlist path. */
export function channelFromUrl(url) {
  const found = MASTER_RE.exec(url || "");
  return found ? decodeURIComponent(found[1]).toLowerCase() : "";
}

/**
 * Is this response body worth reading?
 *
 * Deliberately broad: the *content* decides master versus media. Segments are
 * excluded explicitly — they are by far the most frequent requests, and reading
 * their bodies would cost a lot for nothing.
 */
export function isPlaylist(url) {
  return PLAYLIST_RE.test(url) && !SEGMENT_RE.test(url);
}

/**
 * Hand the player a playlist, keeping everything Twitch said about it.
 *
 * The body is ours; the status and the headers are not. An earlier version
 * built a bare 200 with two headers of its own, discarding the rest — caching
 * directives, `Date`, the low-latency hints the player reads to schedule its
 * next poll. Replacing a playlist is no reason to rewrite its envelope.
 */
function playlistResponse(text, source, from) {
  const headers = new Headers(from ? from.headers : undefined);
  headers.set("Content-Type", HLS_MIME);
  headers.set("X-Ads-Remove-Source", source);
  return new Response(text, {
    status: from ? from.status : 200,
    statusText: from ? from.statusText : "OK",
    headers,
  });
}

/**
 * Install the hook in a worker scope.
 *
 * `scope` is `self` in production; tests pass a fake scope, which is what makes
 * this file verifiable without a browser.
 */
export function installHook(scope, options = {}) {
  const originalFetch = scope.fetch.bind(scope);
  const token = options.token || scope.__ADS_REMOVE_TOKEN || "shared";
  // Identifier for THIS worker. The player creates several and recreates one on
  // every reload; without distinct ids their reports overwrite each other and
  // the counters restart from zero — exactly what aggregation exists to avoid.
  const wid = options.wid || `w${Math.random().toString(36).slice(2, 8)}`;

  // The off switch. False makes the hook a pass-through: no body is read, no
  // telemetry is sent, and the player gets byte-for-byte what Twitch returned.
  let enabled = options.enabled !== false;

  // Whether the tab is in the background, pushed down by the page: a worker has
  // no `document` to ask. Only used to annotate the log — a freeze that happens
  // only when hidden is a different animal from one that happens anywhere.
  let hidden = false;

  // Private channel. Never `scope.postMessage`, which belongs to the player. The
  // name carries a per-page token so another Twitch tab does not receive this
  // tab's telemetry.
  let channel = null;
  try {
    channel = new scope.BroadcastChannel(`twitch-ads-remove-${token}`);
  } catch {
    channel = null;
  }

  const send = (message) => {
    if (!channel) return;
    try {
      channel.postMessage({ ...message, wid });
    } catch {
      /* channel closed: not important */
    }
  };

  const trace = (url) => {
    if (scope.__ADS_REMOVE_TRACE) {
      send({ key: "ADS_Event", event: { type: "traceFetch", url: url.slice(0, 100) } });
    }
  };

  /** Engine requests go through the original fetch, never through the hook. */
  async function fetcher(method, url, headers, body) {
    const response = await originalFetch(url, {
      method,
      headers: headers || undefined,
      body: body || undefined,
      // No cookies on backup calls: they must look like an anonymous session.
      credentials: "omit",
      signal: deadline(),
    });
    return { status: response.status, text: await response.text() };
  }

  const blocker = createBlocker({
    fetcher,
    onReload: (reason) => {
      send({ key: "ADS_Reload", reason });
      return true;
    },
    onEvent: (event) => send({ key: "ADS_Event", event }),
    options: options.options || {},
  });

  scope.fetch = async function hookedFetch(input, init) {
    // First line, before anything is read or cloned: switched off must cost
    // nothing and change nothing.
    if (!enabled) return originalFetch(input, init);

    const url = urlOf(input);
    trace(url);

    if (!isPlaylist(url)) return originalFetch(input, init);

    const started = Date.now();
    const response = await originalFetch(input, init);
    if (!response.ok) return response;

    // Read the body ONCE, never through `clone()`.
    //
    // Cloning tees the stream into two branches. Both were consumed only when
    // the playlist came back unchanged; as soon as one was replaced, the
    // player received a response of ours and the original branch was left
    // unread — on every poll, of every rendition, for the life of the tab.
    // Nothing reclaims those, and the reading the engine does is exactly the
    // reading the player needs, so there was never a second branch to justify.
    let text;
    try {
      text = await response.text();
    } catch {
      return response;
    }

    // From here the body is consumed: the player can only be served a response
    // built from the text, never `response` itself.
    const held = () => {
      const ms = Date.now() - started;
      if (ms >= HOLD_WARN_MS) {
        send({ key: "ADS_Event", event: { type: "slowHold", ms, hidden } });
      }
      return ms;
    };

    if (!text.startsWith("#EXTM3U")) {
      held();
      return playlistResponse(text, "passthrough", response);
    }

    try {
      if (isMaster(text)) {
        const out = blocker.onMaster(url, text, channelFromUrl(url));
        held();
        return playlistResponse(out, out === text ? "origin" : "master", response);
      }
      const out = await blocker.onMedia(url, text);
      held();
      return playlistResponse(out, out === text ? "origin" : "media", response);
    } catch (error) {
      // An engine error must never break playback: hand back what Twitch sent,
      // ads included.
      send({ key: "ADS_Event", event: { type: "error", message: String(error && error.message) } });
      held();
      return playlistResponse(text, "origin", response);
    }
  };

  // What the page sends down: the channel being watched, the off switch, the
  // learned order of the backup sources, and whether the tab is visible. No
  // credentials travel: backup requests are anonymous by construction.
  if (channel) {
    channel.addEventListener("message", (event) => {
      const data = event && event.data;
      if (data && data.key === "ADS_Channel") blocker.setChannel(data.channel);
      else if (data && data.key === "ADS_Enabled") {
        enabled = data.enabled !== false;
        blocker.setEnabled(enabled);
      } else if (data && data.key === "ADS_Ranking") blocker.setRanking(data.order);
      else if (data && data.key === "ADS_Visible") hidden = data.hidden === true;
    });
  }

  const timer = setInterval(() => {
    if (enabled) send({ key: "ADS_Stats", stats: blocker.stats() });
  }, options.telemetryMs || TELEMETRY_MS);

  send({ key: "ADS_Ready" });
  return {
    blocker,
    stop: () => {
      clearInterval(timer);
      if (channel) channel.close();
    },
  };
}
