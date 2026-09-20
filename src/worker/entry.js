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

function textResponse(text, origin) {
  return new Response(text, {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": HLS_MIME, "X-Ads-Remove-Source": origin },
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

    const response = await originalFetch(input, init);
    if (!response.ok) return response;

    // Read the body from a clone: if anything fails afterwards, the original
    // response is still consumable by the player.
    let text;
    try {
      text = await response.clone().text();
    } catch {
      return response;
    }
    if (!text.startsWith("#EXTM3U")) return response;

    try {
      if (isMaster(text)) {
        const out = blocker.onMaster(url, text, channelFromUrl(url));
        return out === text ? response : textResponse(out, "master");
      }
      const out = await blocker.onMedia(url, text);
      return out === text ? response : textResponse(out, "media");
    } catch (error) {
      // An engine error must never break playback: hand back the original
      // response, ads included.
      send({ key: "ADS_Event", event: { type: "error", message: String(error && error.message) } });
      return response;
    }
  };

  // Three things are received from the page: the channel being watched, the off
  // switch, and the learned order of the backup sources. No credentials travel:
  // backup requests are anonymous by construction.
  if (channel) {
    channel.addEventListener("message", (event) => {
      const data = event && event.data;
      if (data && data.key === "ADS_Channel") blocker.setChannel(data.channel);
      else if (data && data.key === "ADS_Enabled") {
        enabled = data.enabled !== false;
        blocker.setEnabled(enabled);
      } else if (data && data.key === "ADS_Ranking") blocker.setRanking(data.order);
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
