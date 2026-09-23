/**
 * HLS playlist parsing and ad-segment detection.
 *
 * Pure module: no I/O, no browser API. It runs in Node (tests) and in a worker.
 * Everything Twitch is likely to change one day lives here, so it can be checked
 * offline against real captured playlists.
 */

/**
 * Generic ad marker. Twitch tags breaks with `CLASS="twitch-stitched-ad"` and
 * `stitched-ad-<n>` ids; matching the substring survives tag renames.
 */
export const AD_SIGNIFIER = "stitched";

/** Title carried by content segments: `#EXTINF:2.000,live`. */
export const LIVE_TITLE = "live";

/** Neutral URL substituted for ad tracking URLs. */
export const NEUTRAL_URL = "https://twitch.tv";

const ATTR_RE = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
const EXTINF_RE = /^#EXTINF:\s*([0-9.]+)\s*,?(.*)$/;
const SEQ_RE = /^#EXT-X-MEDIA-SEQUENCE:[ \t]*([0-9]+)[ \t]*$/m;

/**
 * Twitch's own copy of the sequence number, which travels beside the standard
 * one and normally holds the same value.
 *
 * Rewriting one and not the other leaves the two disagreeing by the whole
 * distance between two Twitch sessions — every swap, and again on the return to
 * live. They move together here for that reason.
 */
const LIVE_SEQ_RE = /^#EXT-X-TWITCH-LIVE-SEQUENCE:[ \t]*([0-9]+)[ \t]*$/m;

const TRACKING_ATTRS = [
  "X-TV-TWITCH-AD-URL",
  "X-TV-TWITCH-AD-CLICK-TRACKING-URL",
  "X-TV-TWITCH-TRIGGER-URL",
];

/**
 * Split an HLS attribute list into an object.
 * Handles commas inside quoted values, common in ad tracking URLs.
 */
export function parseAttributes(value) {
  const out = {};
  if (!value) return out;
  // `matchAll` rather than repeated `exec`: no shared `lastIndex` to reset.
  for (const match of value.matchAll(ATTR_RE)) {
    let raw = (match[2] || "").trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    out[match[1]] = raw;
  }
  return out;
}

function lines(text) {
  return String(text).replace(/\r/g, "").split("\n");
}

/** First non-empty, non-comment line after `start`. */
function nextUrl(all, start) {
  for (const candidate of all.slice(start, start + 3)) {
    const stripped = candidate.trim();
    if (stripped && !stripped.startsWith("#")) return stripped;
  }
  return "";
}

function toFloat(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/** True when the playlist is a master (list of renditions). */
export function isMaster(text) {
  return String(text).includes("#EXT-X-STREAM-INF");
}

/**
 * Cheapest possible test for ads in a playlist. This runs on every playlist
 * response — every ~2s, per rendition — hence the plain substring search.
 */
export function hasAdMarkers(text) {
  return String(text).includes(AD_SIGNIFIER);
}

/** HEVC renditions break a hot stream swap: the decoder cannot change codec. */
export function isHevc(codecs) {
  const c = codecs || "";
  return c.startsWith("hev") || c.startsWith("hvc");
}

/** A segment is an ad as soon as its title is not exactly `live`. */
export function isAdSegment(segment) {
  return (segment.title || "").trim().toLowerCase() !== LIVE_TITLE;
}

/** Extract the renditions declared by a master playlist. */
export function parseVariants(text) {
  const all = lines(text);
  const variants = [];

  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const url = nextUrl(all, i + 1);
    if (!url) continue;
    const attrs = parseAttributes(line.includes(":") ? line.split(":").slice(1).join(":") : "");
    variants.push({
      url,
      bandwidth: toInt(attrs.BANDWIDTH),
      resolution: attrs.RESOLUTION || "",
      codecs: attrs.CODECS || "",
      groupId: attrs.VIDEO || "",
      name: "",
      // Plain field, not a getter: a variant crosses `postMessage`, which
      // cannot serialise accessors.
      isHevc: isHevc(attrs.CODECS),
    });
  }

  // Human-readable names ("1080p60") live in #EXT-X-MEDIA, paired by GROUP-ID.
  const names = {};
  for (const line of all) {
    if (!line.startsWith("#EXT-X-MEDIA")) continue;
    const attrs = parseAttributes(line.includes(":") ? line.split(":").slice(1).join(":") : "");
    if (attrs["GROUP-ID"]) names[attrs["GROUP-ID"]] = attrs.NAME || "";
  }
  for (const variant of variants) variant.name = names[variant.groupId] || "";

  return variants;
}

/** Display label for a rendition. */
export function qualityLabel(variant) {
  if (!variant) return "?";
  return variant.name || variant.resolution || "?";
}

/** Parse a media playlist and classify every segment as ad or content. */
export function parseMedia(text) {
  const playlist = {
    segments: [],
    adBreaks: [],
    prefetch: [],
    mediaSequence: 0,
    hasAdMarkers: hasAdMarkers(text),
  };
  const all = lines(text);
  let pendingDiscontinuity = false;

  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      playlist.mediaSequence = toInt(line.split(":").slice(1).join(":").trim());
    } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      pendingDiscontinuity = true;
    } else if (line.startsWith("#EXT-X-DATERANGE:")) {
      const attrs = parseAttributes(line.split(":").slice(1).join(":"));
      const klass = attrs.CLASS || "";
      const id = attrs.ID || "";
      // A real break carries seven DATERANGE tags; only one describes the ad.
      if (!klass.includes(AD_SIGNIFIER) && !id.includes(AD_SIGNIFIER)) continue;
      playlist.adBreaks.push({
        id,
        duration: toFloat(attrs.DURATION),
        rollType: attrs["X-TV-TWITCH-AD-ROLL-TYPE"] || "",
        podLength: toInt(attrs["X-TV-TWITCH-AD-POD-LENGTH"]),
        attributes: attrs,
      });
    } else if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) {
      playlist.prefetch.push(line.split(":").slice(1).join(":").trim());
    } else if (line.startsWith("#EXTINF:")) {
      const match = EXTINF_RE.exec(line);
      if (!match) continue;
      const url = nextUrl(all, i + 1);
      if (!url) continue;
      playlist.segments.push({
        url,
        duration: toFloat(match[1]),
        title: match[2],
        discontinuity: pendingDiscontinuity,
      });
      pendingDiscontinuity = false;
    }
  }

  return playlist;
}

export function adSegments(playlist) {
  return playlist.segments.filter(isAdSegment);
}

export function liveSegments(playlist) {
  return playlist.segments.filter((s) => !isAdSegment(s));
}

/**
 * Is an ad break running?
 *
 * The marker alone is not enough: the break's `#EXT-X-DATERANGE` stays in the
 * sliding window long after the ad segments are gone. Trusting it kept a break
 * "running" for another minute, inflating the ad time reported and showing a
 * 20s preroll as lasting 44s.
 *
 * The rule that holds: there is a break if ad segments remain, or if the marker
 * is present and no live segment is being served.
 */
export function isAdBreak(playlist) {
  if (adSegments(playlist).length > 0) return true;
  return playlist.hasAdMarkers && liveSegments(playlist).length === 0;
}

export function rollType(playlist) {
  for (const brk of playlist.adBreaks) if (brk.rollType) return brk.rollType;
  return "";
}

function neutraliseTracking(line) {
  let out = line;
  for (const attr of TRACKING_ATTRS) {
    out = out.replace(new RegExp(`(${attr}=")[^"]*(")`, "g"), `$1${NEUTRAL_URL}$2`);
  }
  return out;
}

/**
 * Remove ad segments from a media playlist.
 *
 * Fallback used when no clean stream could be obtained. It does **not** restore
 * the live content: under SSAI the content is not broadcast during the break.
 *
 * Returns `{ text, removed }`.
 */
export function stripAds(text) {
  const all = lines(text);
  const out = [];
  let removed = 0;
  /**
   * Ad segments dropped *before* the first one kept.
   *
   * `#EXT-X-MEDIA-SEQUENCE` numbers the first segment of the playlist, and the
   * rest follow by position. Dropping segments from the head therefore renames
   * every segment after them unless the sequence is raised to match — the
   * player would receive the same segment under a new number on each poll,
   * re-download it, and never see the timeline advance.
   */
  let removedBefore = 0;
  let kept = 0;
  let skipNextUrl = false;
  const duringBreak = hasAdMarkers(text);

  for (let line of all) {
    if (skipNextUrl && line.trim() && !line.startsWith("#")) {
      skipNextUrl = false;
      continue;
    }
    skipNextUrl = false;

    if (line.startsWith("#EXTINF:")) {
      const match = EXTINF_RE.exec(line);
      if (match && match[2].trim().toLowerCase() !== LIVE_TITLE) {
        removed += 1;
        if (kept === 0) removedBefore += 1;
        skipNextUrl = true;
        continue;
      }
      kept += 1;
    }

    // A prefetched segment cannot be classified, so low-latency prefetch is
    // disabled for the duration of the break — otherwise the player shows the
    // ad through it anyway.
    if (line.startsWith("#EXT-X-TWITCH-PREFETCH:") && duringBreak) continue;

    if (line.startsWith("#EXT-X-DATERANGE:")) line = neutraliseTracking(line);

    out.push(line);
  }

  let cleaned = out.join("\n");
  if (removedBefore > 0 && kept > 0) {
    cleaned = writeMediaSequence(cleaned, readMediaSequence(cleaned) + removedBefore);
  }
  return { text: cleaned, removed, removedBefore };
}

/** Media sequence number announced by the playlist (0 if absent). */
export function readMediaSequence(text) {
  const found = SEQ_RE.exec(String(text));
  return found ? Number(found[1]) : 0;
}

/**
 * Rewrite `#EXT-X-MEDIA-SEQUENCE`.
 *
 * Required when switching source: every Twitch session has its own numbering
 * (a preroll even restarts at 0), and a live playlist whose sequence number
 * goes **backwards** is stale to a player — it waits instead of playing, which
 * looks like a load that never finishes.
 */
export function writeMediaSequence(text, value) {
  const n = Math.max(0, Math.floor(value));
  const source = String(text);
  if (SEQ_RE.test(source)) {
    const before = Number(SEQ_RE.exec(source)[1]);
    let out = source.replace(SEQ_RE, `#EXT-X-MEDIA-SEQUENCE:${n}`);
    // Twitch's own counter has to travel the same distance. Left alone, it
    // still carries the numbering of whichever session the body came from,
    // while the standard tag carries ours — the two then disagree by the gap
    // between two sessions, which is arbitrary.
    const live = LIVE_SEQ_RE.exec(out);
    if (live) {
      const shifted = Math.max(0, Number(live[1]) + n - before);
      out = out.replace(LIVE_SEQ_RE, `#EXT-X-TWITCH-LIVE-SEQUENCE:${shifted}`);
    }
    return out;
  }
  const all = lines(source);
  const header = all.findIndex((l) => l.startsWith("#EXTM3U"));
  const at = header === -1 ? 0 : header + 1;
  return [...all.slice(0, at), `#EXT-X-MEDIA-SEQUENCE:${n}`, ...all.slice(at)].join("\n");
}

/** Number of segments announced, without parsing the whole playlist. */
export function countSegments(text) {
  return (String(text).match(/^#EXTINF:/gm) || []).length;
}

/**
 * Insert `#EXT-X-DISCONTINUITY` before the first segment.
 *
 * Required on every source switch. Segments then come from another playback
 * session whose timestamps are rewritten independently; without the tag audio
 * resynchronises but the picture freezes.
 */
export function markDiscontinuity(text, before = 0) {
  if (before < 0) return text;
  const all = lines(text);
  let seen = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (!all[i].startsWith("#EXTINF:")) continue;
    if (seen !== before) {
      seen += 1;
      continue;
    }
    if (i > 0 && all[i - 1].startsWith("#EXT-X-DISCONTINUITY")) return text;
    return [...all.slice(0, i), "#EXT-X-DISCONTINUITY", ...all.slice(i)].join("\n");
  }
  return text; // the window does not reach that segment
}

/**
 * Remove HEVC renditions from a master playlist.
 *
 * Twitch encodes 1440p/4K in HEVC but offers no HEVC replacement feed. If the
 * player settles on an HEVC rendition, any substitution feeds AVC into a
 * decoder initialised for HEVC — Chromium reports "error 3000".
 *
 * Returns `{ text, removed }`.
 */
export function stripHevcVariants(text) {
  const all = lines(text);
  const droppedGroups = new Set();
  const kept = [];
  let removed = 0;
  let i = 0;

  while (i < all.length) {
    const line = all[i];
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttributes(line.includes(":") ? line.split(":").slice(1).join(":") : "");
      if (isHevc(attrs.CODECS)) {
        droppedGroups.add(attrs.VIDEO || "");
        removed += 1;
        // Skip the URL that immediately follows.
        i += 1;
        while (i < all.length && (!all[i].trim() || all[i].startsWith("#"))) i += 1;
        i += 1;
        continue;
      }
    }
    kept.push(line);
    i += 1;
  }

  if (!removed) return { text, removed: 0 };

  // Orphaned #EXT-X-MEDIA tags must go with their rendition.
  const out = [];
  for (const line of kept) {
    if (line.startsWith("#EXT-X-MEDIA")) {
      const attrs = parseAttributes(line.includes(":") ? line.split(":").slice(1).join(":") : "");
      if (droppedGroups.has(attrs["GROUP-ID"] || "")) continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}
