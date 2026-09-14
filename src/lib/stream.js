/**
 * Obtaining an ad-free Twitch stream.
 *
 * Under SSAI the live content is not broadcast during a break, so stripping ads
 * restores nothing. The only way to keep watching is to request *another feed of
 * the same stream*, issued for a different `playerType`, and hope it is not
 * stitched.
 *
 * The chain, per candidate:
 *
 *   1. `POST gql.twitch.tv/gql` — PlaybackAccessToken -> {value, signature}
 *   2. `GET usher.ttvnw.net/api/channel/hls/<channel>.m3u8?sig=…&token=…`
 *   3. `GET <rendition>` — if it carries no ad marker, the feed is clean.
 *
 * Pure module: all I/O goes through an injected
 * `fetcher(method, url, headers, body) -> Promise<{status, text}>`.
 */

import { hasAdMarkers, isHevc, parseVariants, qualityLabel } from "./hls.js";

export const GQL_URL = "https://gql.twitch.tv/gql";
export const USHER_URL = "https://usher.ttvnw.net/api/channel/hls/{channel}.m3u8";

/** Public Client-ID of the Twitch web player. A public constant, not a secret. */
export const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

/**
 * Persisted-query hash for `PlaybackAccessToken`.
 * Volatile: one of the first things Twitch will change.
 */
export const PERSISTED_HASH =
  "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";

/**
 * Backup candidates, in preference order. Measured against three live channels
 * with `tests/probe-candidates.mjs`:
 *
 * - `site/web` is the only pair that is consistently stitched — it is the
 *   player's own `playerType`, so a fresh token arrives with its ad. It is
 *   excluded.
 * - Nine pairs return source quality (up to 1080p60).
 * - `server_ads` and `hide_ads`, readable in the token, are identical for every
 *   pair: they describe the channel, not the session.
 *
 * Candidates are tried in parallel, so a longer list costs requests, not time.
 */
export const BACKUP_CANDIDATES = [
  { playerType: "popout", platform: "web" },
  { playerType: "mobile_web", platform: "web" },
  { playerType: "embed", platform: "web" },
  { playerType: "frontpage", platform: "web" },
  { playerType: "channel_home_carousel", platform: "web" },
  { playerType: "site", platform: "ios" },
  { playerType: "site", platform: "android" },
  { playerType: "embed", platform: "ios" },
  { playerType: "mobile_web", platform: "ios" },
];

/**
 * Last resort, at degraded quality (measured at 480p and 360p). Serving 480p to
 * a player that asked for source is a downgrade, but a milder one than a full
 * ad break — and these are only reached once the list above is exhausted.
 *
 * `autoplay` stays excluded despite its 360p: it leaves the player on an endless
 * loading spinner when the break ends.
 */
export const LOW_QUALITY_CANDIDATES = [
  { playerType: "thunderdome", platform: "web" },
  { playerType: "picture-by-picture", platform: "web" },
];

export function candidateLabel(candidate) {
  return `${candidate.playerType}/${candidate.platform}`;
}

/** Body of the GQL `PlaybackAccessToken` request. */
export function tokenPayload(channel, playerType, platform = "web") {
  return {
    operationName: "PlaybackAccessToken",
    variables: {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: "",
      playerType,
      platform,
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } },
  };
}

/** Master playlist URL for a given signature/token pair. */
export function usherUrl(channel, signature, token, random = Math.random) {
  const params = new URLSearchParams({
    sig: signature,
    token,
    allow_source: "true",
    allow_audio_only: "true",
    fast_bread: "true",
    player_backend: "mediaplayer",
    playlist_include_framerate: "true",
    reassignments_supported: "true",
    supported_codecs: "avc1", // HEVC breaks a hot swap
    transcode_mode: "cbr_v1",
    p: String(1_000_000 + Math.floor(random() * 9_000_000)),
  });
  return `${USHER_URL.replace("{channel}", encodeURIComponent(channel))}?${params}`;
}

/**
 * Headers for backup requests: nothing beyond the public Client-ID.
 *
 * Two reasons, the second being the important one.
 *
 * 1. It works better. Measured on one channel, same instant, same preroll: with
 *    identity headers, 11 candidates out of 11 came back stitched; without them,
 *    a clean feed was found. Twitch ties the request to the same viewer and
 *    serves the same campaign everywhere — whereas a backup feed exists precisely
 *    to look like a *different* viewer.
 * 2. No secret is moved. Harvesting the page's OAuth token to pass it to the
 *    worker would mean broadcasting it on a same-origin channel.
 *
 * Accepted cost: channels that refuse an anonymous token get no backup feed.
 */
export function headers() {
  return {
    "Client-ID": CLIENT_ID,
    "Content-Type": "text/plain;charset=UTF-8",
  };
}

/** Extract `{value, signature}` from a GQL response, or null. */
export function readToken(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = Array.isArray(payload) ? payload : [payload];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const data = entry.data || {};
    const token = data.streamPlaybackAccessToken || data.videoPlaybackAccessToken;
    if (token && token.value && token.signature) {
      return { value: token.value, signature: token.signature };
    }
  }
  return null;
}

/**
 * Pick the backup rendition closest to the one the player is reading.
 * HEVC is always excluded: changing codec family mid-stream breaks the decoder.
 */
export function pickVariant(variants, wanted) {
  const usable = variants.filter((v) => !v.isHevc && !isHevc(v.codecs));
  if (!usable.length) return null;
  if (wanted) {
    const exact = usable.filter((v) => v.resolution === wanted.resolution);
    if (exact.length) return exact[0];
    // Otherwise the best rendition below the requested one.
    const lower = usable.filter((v) => v.bandwidth <= wanted.bandwidth);
    if (lower.length) return lower.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  }
  return usable.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
}

function cleanStream(channel, label, variant, media, master) {
  return {
    channel,
    playerType: label,
    mediaUrl: variant.url,
    variant,
    body: media,
    master,
    quality: qualityLabel(variant),
  };
}

/** Full chain for one candidate. Never rejects. */
async function tryCandidate(candidate, channel, hdrs, fetcher, wanted) {
  const label = candidateLabel(candidate);
  try {
    const gql = await fetcher(
      "POST",
      GQL_URL,
      hdrs,
      JSON.stringify(tokenPayload(channel, candidate.playerType, candidate.platform)),
    );
    if (gql.status !== 200) return { candidate, stream: null, reason: `gql HTTP ${gql.status}` };

    const token = readToken(gql.text);
    if (!token) return { candidate, stream: null, reason: "gql returned no token" };

    const master = await fetcher("GET", usherUrl(channel, token.signature, token.value), null, null);
    if (master.status !== 200) {
      return { candidate, stream: null, reason: `usher HTTP ${master.status}` };
    }

    const variant = pickVariant(parseVariants(master.text), wanted);
    if (!variant) return { candidate, stream: null, reason: "no usable rendition" };

    const media = await fetcher("GET", variant.url, null, null);
    if (media.status !== 200) {
      return { candidate, stream: null, reason: `media HTTP ${media.status}` };
    }
    if (hasAdMarkers(media.text)) {
      return { candidate, stream: null, reason: "feed is stitched too" };
    }

    return {
      candidate,
      stream: cleanStream(channel, label, variant, media.text, master.text),
      reason: "",
    };
  } catch (error) {
    return { candidate, stream: null, reason: String((error && error.message) || error) };
  }
}

/**
 * Find an ad-free media playlist, trying every candidate in parallel.
 *
 * Sequentially each candidate costs ~0.65s, so the first clean feed arrived
 * about 2s into the break — two seconds during which the player only received a
 * stripped playlist. The result is still the *first clean candidate in list
 * order*, so parallelism does not degrade the choice.
 *
 * Never rejects: every failure is recorded in `attempts`.
 */
export async function findCleanStream(
  channel,
  fetcher,
  wanted = null,
  candidates = BACKUP_CANDIDATES,
) {
  const result = { stream: null, attempts: [] };
  if (!candidates.length) return result;
  const hdrs = headers();

  const verdicts = await Promise.all(
    candidates.map((c) => tryCandidate(c, channel, hdrs, fetcher, wanted)),
  );

  for (const verdict of verdicts) {
    if (verdict.stream) {
      result.stream = verdict.stream;
      return result;
    }
    result.attempts.push([candidateLabel(verdict.candidate), verdict.reason]);
  }
  return result;
}

/**
 * Derive a clean feed from a master playlist already obtained, for another
 * rendition of the same channel.
 *
 * The player polls several renditions at once; without this, each would replay
 * the whole chain for every candidate. The absence of ads is re-checked anyway,
 * since the ad server can catch one rendition and not another.
 */
export async function cleanStreamFromMaster(channel, label, master, fetcher, wanted = null) {
  const variant = pickVariant(parseVariants(master), wanted);
  if (!variant) return null;
  let media;
  try {
    media = await fetcher("GET", variant.url, null, null);
  } catch {
    return null;
  }
  if (media.status !== 200 || hasAdMarkers(media.text)) return null;
  return cleanStream(channel, label, variant, media.text, master);
}
