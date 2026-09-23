/**
 * The part that runs in the page's MAIN world.
 *
 * Three jobs:
 *
 * 1. Hook `Worker` — the player fetches its playlists from a Web Worker built
 *    from a blob. Rebuilding that blob with our code prepended is the only way
 *    to see the playlists go by.
 * 2. Tell the engine which channel is being watched — it is in the address, and
 *    the worker does not always see the master playlist.
 * 3. Reload the player on request, and hide an ad that cannot be replaced.
 * 4. Obey the off switch, including on the very first line of a page load.
 *
 * No credentials ever leave the page. The player's OAuth token was harvested at
 * one point to pass it to the worker: that was both useless (Twitch then serves
 * the same campaign to every `playerType`) and unwise (broadcasting a secret on
 * a same-origin channel). Backup requests are anonymous.
 *
 * This is a classic script, not a module: content scripts cannot use
 * `type="module"`. The worker preamble is injected at build time in place of
 * `WORKER_PAYLOAD`.
 */

(() => {
  "use strict";

  const WORKER_PAYLOAD = "(() => {\n\"use strict\";\n/* src/lib/hls.js */\n/**\n * HLS playlist parsing and ad-segment detection.\n *\n * Pure module: no I/O, no browser API. It runs in Node (tests) and in a worker.\n * Everything Twitch is likely to change one day lives here, so it can be checked\n * offline against real captured playlists.\n */\n\n/**\n * Generic ad marker. Twitch tags breaks with `CLASS=\"twitch-stitched-ad\"` and\n * `stitched-ad-<n>` ids; matching the substring survives tag renames.\n */\nconst AD_SIGNIFIER = \"stitched\";\n\n/** Title carried by content segments: `#EXTINF:2.000,live`. */\nconst LIVE_TITLE = \"live\";\n\n/** Neutral URL substituted for ad tracking URLs. */\nconst NEUTRAL_URL = \"https://twitch.tv\";\n\nconst ATTR_RE = /([A-Za-z0-9-]+)=(\"[^\"]*\"|[^,]*)/g;\nconst EXTINF_RE = /^#EXTINF:\\s*([0-9.]+)\\s*,?(.*)$/;\nconst SEQ_RE = /^#EXT-X-MEDIA-SEQUENCE:[ \\t]*([0-9]+)[ \\t]*$/m;\n\n/**\n * Twitch's own copy of the sequence number, which travels beside the standard\n * one and normally holds the same value.\n *\n * Rewriting one and not the other leaves the two disagreeing by the whole\n * distance between two Twitch sessions — every swap, and again on the return to\n * live. They move together here for that reason.\n */\nconst LIVE_SEQ_RE = /^#EXT-X-TWITCH-LIVE-SEQUENCE:[ \\t]*([0-9]+)[ \\t]*$/m;\n\nconst TRACKING_ATTRS = [\n  \"X-TV-TWITCH-AD-URL\",\n  \"X-TV-TWITCH-AD-CLICK-TRACKING-URL\",\n  \"X-TV-TWITCH-TRIGGER-URL\",\n];\n\n/**\n * Split an HLS attribute list into an object.\n * Handles commas inside quoted values, common in ad tracking URLs.\n */\nfunction parseAttributes(value) {\n  const out = {};\n  if (!value) return out;\n  // `matchAll` rather than repeated `exec`: no shared `lastIndex` to reset.\n  for (const match of value.matchAll(ATTR_RE)) {\n    let raw = (match[2] || \"\").trim();\n    if (raw.length >= 2 && raw.startsWith('\"') && raw.endsWith('\"')) {\n      raw = raw.slice(1, -1);\n    }\n    out[match[1]] = raw;\n  }\n  return out;\n}\n\nfunction lines(text) {\n  return String(text).replace(/\\r/g, \"\").split(\"\\n\");\n}\n\n/** First non-empty, non-comment line after `start`. */\nfunction nextUrl(all, start) {\n  for (const candidate of all.slice(start, start + 3)) {\n    const stripped = candidate.trim();\n    if (stripped && !stripped.startsWith(\"#\")) return stripped;\n  }\n  return \"\";\n}\n\nfunction toFloat(value) {\n  const n = Number.parseFloat(value);\n  return Number.isFinite(n) ? n : 0;\n}\n\nfunction toInt(value) {\n  const n = Number.parseInt(value, 10);\n  return Number.isFinite(n) ? n : 0;\n}\n\n/** True when the playlist is a master (list of renditions). */\nfunction isMaster(text) {\n  return String(text).includes(\"#EXT-X-STREAM-INF\");\n}\n\n/**\n * Cheapest possible test for ads in a playlist. This runs on every playlist\n * response — every ~2s, per rendition — hence the plain substring search.\n */\nfunction hasAdMarkers(text) {\n  return String(text).includes(AD_SIGNIFIER);\n}\n\n/** HEVC renditions break a hot stream swap: the decoder cannot change codec. */\nfunction isHevc(codecs) {\n  const c = codecs || \"\";\n  return c.startsWith(\"hev\") || c.startsWith(\"hvc\");\n}\n\n/** A segment is an ad as soon as its title is not exactly `live`. */\nfunction isAdSegment(segment) {\n  return (segment.title || \"\").trim().toLowerCase() !== LIVE_TITLE;\n}\n\n/** Extract the renditions declared by a master playlist. */\nfunction parseVariants(text) {\n  const all = lines(text);\n  const variants = [];\n\n  for (let i = 0; i < all.length; i += 1) {\n    const line = all[i];\n    if (!line.startsWith(\"#EXT-X-STREAM-INF\")) continue;\n    const url = nextUrl(all, i + 1);\n    if (!url) continue;\n    const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n    variants.push({\n      url,\n      bandwidth: toInt(attrs.BANDWIDTH),\n      resolution: attrs.RESOLUTION || \"\",\n      codecs: attrs.CODECS || \"\",\n      groupId: attrs.VIDEO || \"\",\n      name: \"\",\n      // Plain field, not a getter: a variant crosses `postMessage`, which\n      // cannot serialise accessors.\n      isHevc: isHevc(attrs.CODECS),\n    });\n  }\n\n  // Human-readable names (\"1080p60\") live in #EXT-X-MEDIA, paired by GROUP-ID.\n  const names = {};\n  for (const line of all) {\n    if (!line.startsWith(\"#EXT-X-MEDIA\")) continue;\n    const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n    if (attrs[\"GROUP-ID\"]) names[attrs[\"GROUP-ID\"]] = attrs.NAME || \"\";\n  }\n  for (const variant of variants) variant.name = names[variant.groupId] || \"\";\n\n  return variants;\n}\n\n/** Display label for a rendition. */\nfunction qualityLabel(variant) {\n  if (!variant) return \"?\";\n  return variant.name || variant.resolution || \"?\";\n}\n\n/** Parse a media playlist and classify every segment as ad or content. */\nfunction parseMedia(text) {\n  const playlist = {\n    segments: [],\n    adBreaks: [],\n    prefetch: [],\n    mediaSequence: 0,\n    hasAdMarkers: hasAdMarkers(text),\n  };\n  const all = lines(text);\n  let pendingDiscontinuity = false;\n\n  for (let i = 0; i < all.length; i += 1) {\n    const line = all[i];\n\n    if (line.startsWith(\"#EXT-X-MEDIA-SEQUENCE:\")) {\n      playlist.mediaSequence = toInt(line.split(\":\").slice(1).join(\":\").trim());\n    } else if (line.startsWith(\"#EXT-X-DISCONTINUITY\")) {\n      pendingDiscontinuity = true;\n    } else if (line.startsWith(\"#EXT-X-DATERANGE:\")) {\n      const attrs = parseAttributes(line.split(\":\").slice(1).join(\":\"));\n      const klass = attrs.CLASS || \"\";\n      const id = attrs.ID || \"\";\n      // A real break carries seven DATERANGE tags; only one describes the ad.\n      if (!klass.includes(AD_SIGNIFIER) && !id.includes(AD_SIGNIFIER)) continue;\n      playlist.adBreaks.push({\n        id,\n        duration: toFloat(attrs.DURATION),\n        rollType: attrs[\"X-TV-TWITCH-AD-ROLL-TYPE\"] || \"\",\n        podLength: toInt(attrs[\"X-TV-TWITCH-AD-POD-LENGTH\"]),\n        attributes: attrs,\n      });\n    } else if (line.startsWith(\"#EXT-X-TWITCH-PREFETCH:\")) {\n      playlist.prefetch.push(line.split(\":\").slice(1).join(\":\").trim());\n    } else if (line.startsWith(\"#EXTINF:\")) {\n      const match = EXTINF_RE.exec(line);\n      if (!match) continue;\n      const url = nextUrl(all, i + 1);\n      if (!url) continue;\n      playlist.segments.push({\n        url,\n        duration: toFloat(match[1]),\n        title: match[2],\n        discontinuity: pendingDiscontinuity,\n      });\n      pendingDiscontinuity = false;\n    }\n  }\n\n  return playlist;\n}\n\nfunction adSegments(playlist) {\n  return playlist.segments.filter(isAdSegment);\n}\n\nfunction liveSegments(playlist) {\n  return playlist.segments.filter((s) => !isAdSegment(s));\n}\n\n/**\n * Is an ad break running?\n *\n * The marker alone is not enough: the break's `#EXT-X-DATERANGE` stays in the\n * sliding window long after the ad segments are gone. Trusting it kept a break\n * \"running\" for another minute, inflating the ad time reported and showing a\n * 20s preroll as lasting 44s.\n *\n * The rule that holds: there is a break if ad segments remain, or if the marker\n * is present and no live segment is being served.\n */\nfunction isAdBreak(playlist) {\n  if (adSegments(playlist).length > 0) return true;\n  return playlist.hasAdMarkers && liveSegments(playlist).length === 0;\n}\n\nfunction rollType(playlist) {\n  for (const brk of playlist.adBreaks) if (brk.rollType) return brk.rollType;\n  return \"\";\n}\n\nfunction neutraliseTracking(line) {\n  let out = line;\n  for (const attr of TRACKING_ATTRS) {\n    out = out.replace(new RegExp(`(${attr}=\")[^\"]*(\")`, \"g\"), `$1${NEUTRAL_URL}$2`);\n  }\n  return out;\n}\n\n/**\n * Remove ad segments from a media playlist.\n *\n * Fallback used when no clean stream could be obtained. It does **not** restore\n * the live content: under SSAI the content is not broadcast during the break.\n *\n * Returns `{ text, removed }`.\n */\nfunction stripAds(text) {\n  const all = lines(text);\n  const out = [];\n  let removed = 0;\n  /**\n   * Ad segments dropped *before* the first one kept.\n   *\n   * `#EXT-X-MEDIA-SEQUENCE` numbers the first segment of the playlist, and the\n   * rest follow by position. Dropping segments from the head therefore renames\n   * every segment after them unless the sequence is raised to match — the\n   * player would receive the same segment under a new number on each poll,\n   * re-download it, and never see the timeline advance.\n   */\n  let removedBefore = 0;\n  let kept = 0;\n  let skipNextUrl = false;\n  const duringBreak = hasAdMarkers(text);\n\n  for (let line of all) {\n    if (skipNextUrl && line.trim() && !line.startsWith(\"#\")) {\n      skipNextUrl = false;\n      continue;\n    }\n    skipNextUrl = false;\n\n    if (line.startsWith(\"#EXTINF:\")) {\n      const match = EXTINF_RE.exec(line);\n      if (match && match[2].trim().toLowerCase() !== LIVE_TITLE) {\n        removed += 1;\n        if (kept === 0) removedBefore += 1;\n        skipNextUrl = true;\n        continue;\n      }\n      kept += 1;\n    }\n\n    // A prefetched segment cannot be classified, so low-latency prefetch is\n    // disabled for the duration of the break — otherwise the player shows the\n    // ad through it anyway.\n    if (line.startsWith(\"#EXT-X-TWITCH-PREFETCH:\") && duringBreak) continue;\n\n    if (line.startsWith(\"#EXT-X-DATERANGE:\")) line = neutraliseTracking(line);\n\n    out.push(line);\n  }\n\n  let cleaned = out.join(\"\\n\");\n  if (removedBefore > 0 && kept > 0) {\n    cleaned = writeMediaSequence(cleaned, readMediaSequence(cleaned) + removedBefore);\n  }\n  return { text: cleaned, removed, removedBefore };\n}\n\n/** Media sequence number announced by the playlist (0 if absent). */\nfunction readMediaSequence(text) {\n  const found = SEQ_RE.exec(String(text));\n  return found ? Number(found[1]) : 0;\n}\n\n/**\n * Rewrite `#EXT-X-MEDIA-SEQUENCE`.\n *\n * Required when switching source: every Twitch session has its own numbering\n * (a preroll even restarts at 0), and a live playlist whose sequence number\n * goes **backwards** is stale to a player — it waits instead of playing, which\n * looks like a load that never finishes.\n */\nfunction writeMediaSequence(text, value) {\n  const n = Math.max(0, Math.floor(value));\n  const source = String(text);\n  if (SEQ_RE.test(source)) {\n    const before = Number(SEQ_RE.exec(source)[1]);\n    let out = source.replace(SEQ_RE, `#EXT-X-MEDIA-SEQUENCE:${n}`);\n    // Twitch's own counter has to travel the same distance. Left alone, it\n    // still carries the numbering of whichever session the body came from,\n    // while the standard tag carries ours — the two then disagree by the gap\n    // between two sessions, which is arbitrary.\n    const live = LIVE_SEQ_RE.exec(out);\n    if (live) {\n      const shifted = Math.max(0, Number(live[1]) + n - before);\n      out = out.replace(LIVE_SEQ_RE, `#EXT-X-TWITCH-LIVE-SEQUENCE:${shifted}`);\n    }\n    return out;\n  }\n  const all = lines(source);\n  const header = all.findIndex((l) => l.startsWith(\"#EXTM3U\"));\n  const at = header === -1 ? 0 : header + 1;\n  return [...all.slice(0, at), `#EXT-X-MEDIA-SEQUENCE:${n}`, ...all.slice(at)].join(\"\\n\");\n}\n\n/** Number of segments announced, without parsing the whole playlist. */\nfunction countSegments(text) {\n  return (String(text).match(/^#EXTINF:/gm) || []).length;\n}\n\n/**\n * Insert `#EXT-X-DISCONTINUITY` before the first segment.\n *\n * Required on every source switch. Segments then come from another playback\n * session whose timestamps are rewritten independently; without the tag audio\n * resynchronises but the picture freezes.\n */\nfunction markDiscontinuity(text, before = 0) {\n  if (before < 0) return text;\n  const all = lines(text);\n  let seen = 0;\n  for (let i = 0; i < all.length; i += 1) {\n    if (!all[i].startsWith(\"#EXTINF:\")) continue;\n    if (seen !== before) {\n      seen += 1;\n      continue;\n    }\n    if (i > 0 && all[i - 1].startsWith(\"#EXT-X-DISCONTINUITY\")) return text;\n    return [...all.slice(0, i), \"#EXT-X-DISCONTINUITY\", ...all.slice(i)].join(\"\\n\");\n  }\n  return text; // the window does not reach that segment\n}\n\n/**\n * Remove HEVC renditions from a master playlist.\n *\n * Twitch encodes 1440p/4K in HEVC but offers no HEVC replacement feed. If the\n * player settles on an HEVC rendition, any substitution feeds AVC into a\n * decoder initialised for HEVC — Chromium reports \"error 3000\".\n *\n * Returns `{ text, removed }`.\n */\nfunction stripHevcVariants(text) {\n  const all = lines(text);\n  const droppedGroups = new Set();\n  const kept = [];\n  let removed = 0;\n  let i = 0;\n\n  while (i < all.length) {\n    const line = all[i];\n    if (line.startsWith(\"#EXT-X-STREAM-INF\")) {\n      const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n      if (isHevc(attrs.CODECS)) {\n        droppedGroups.add(attrs.VIDEO || \"\");\n        removed += 1;\n        // Skip the URL that immediately follows.\n        i += 1;\n        while (i < all.length && (!all[i].trim() || all[i].startsWith(\"#\"))) i += 1;\n        i += 1;\n        continue;\n      }\n    }\n    kept.push(line);\n    i += 1;\n  }\n\n  if (!removed) return { text, removed: 0 };\n\n  // Orphaned #EXT-X-MEDIA tags must go with their rendition.\n  const out = [];\n  for (const line of kept) {\n    if (line.startsWith(\"#EXT-X-MEDIA\")) {\n      const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n      if (droppedGroups.has(attrs[\"GROUP-ID\"] || \"\")) continue;\n    }\n    out.push(line);\n  }\n  return { text: out.join(\"\\n\"), removed };\n}\n\n/* src/lib/stream.js */\n/**\n * Obtaining an ad-free Twitch stream.\n *\n * Under SSAI the live content is not broadcast during a break, so stripping ads\n * restores nothing. The only way to keep watching is to request *another feed of\n * the same stream*, issued for a different `playerType`, and hope it is not\n * stitched.\n *\n * The chain, per candidate:\n *\n *   1. `POST gql.twitch.tv/gql` — PlaybackAccessToken -> {value, signature}\n *   2. `GET usher.ttvnw.net/api/channel/hls/<channel>.m3u8?sig=…&token=…`\n *   3. `GET <rendition>` — if it carries no ad marker, the feed is clean.\n *\n * Pure module: all I/O goes through an injected\n * `fetcher(method, url, headers, body) -> Promise<{status, text}>`.\n */\n\n\n\nconst GQL_URL = \"https://gql.twitch.tv/gql\";\nconst USHER_URL = \"https://usher.ttvnw.net/api/channel/hls/{channel}.m3u8\";\n\n/** Public Client-ID of the Twitch web player. A public constant, not a secret. */\nconst CLIENT_ID = \"kimne78kx3ncx6brgo4mv6wki5h1ko\";\n\n/**\n * Persisted-query hash for `PlaybackAccessToken`.\n * Volatile: one of the first things Twitch will change.\n */\nconst PERSISTED_HASH =\n  \"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9\";\n\n/**\n * Backup candidates, in preference order. Measured against three live channels\n * with `tests/probe-candidates.mjs`:\n *\n * - `site/web` is the only pair that is consistently stitched — it is the\n *   player's own `playerType`, so a fresh token arrives with its ad. It is\n *   excluded.\n * - Nine pairs return source quality (up to 1080p60).\n * - `server_ads` and `hide_ads`, readable in the token, are identical for every\n *   pair: they describe the channel, not the session.\n *\n * Candidates are tried in parallel, so a longer list costs requests, not time.\n */\nconst BACKUP_CANDIDATES = [\n  { playerType: \"popout\", platform: \"web\" },\n  { playerType: \"mobile_web\", platform: \"web\" },\n  { playerType: \"embed\", platform: \"web\" },\n  { playerType: \"frontpage\", platform: \"web\" },\n  { playerType: \"channel_home_carousel\", platform: \"web\" },\n  { playerType: \"site\", platform: \"ios\" },\n  { playerType: \"site\", platform: \"android\" },\n  { playerType: \"embed\", platform: \"ios\" },\n  { playerType: \"mobile_web\", platform: \"ios\" },\n];\n\n/**\n * Last resort, at degraded quality (measured at 480p and 360p). Serving 480p to\n * a player that asked for source is a downgrade, but a milder one than a full\n * ad break — and these are only reached once the list above is exhausted.\n *\n * `autoplay` stays excluded despite its 360p: it leaves the player on an endless\n * loading spinner when the break ends.\n */\nconst LOW_QUALITY_CANDIDATES = [\n  { playerType: \"thunderdome\", platform: \"web\" },\n  { playerType: \"picture-by-picture\", platform: \"web\" },\n];\n\nfunction candidateLabel(candidate) {\n  return `${candidate.playerType}/${candidate.platform}`;\n}\n\n/**\n * Reorder candidates according to a learned order of labels.\n *\n * Advice, not a filter: a label missing from the order keeps its place at the\n * end rather than being dropped, so an order that has gone stale against a\n * newer candidate list can never make a candidate unreachable.\n */\nfunction orderCandidates(candidates, order) {\n  if (!Array.isArray(order) || !order.length) return candidates;\n  const rank = new Map(order.map((label, index) => [label, index]));\n  const place = (candidate) => {\n    const found = rank.get(candidateLabel(candidate));\n    return found === undefined ? Number.MAX_SAFE_INTEGER : found;\n  };\n  return candidates\n    .map((candidate, index) => ({ candidate, index }))\n    .sort((a, b) => place(a.candidate) - place(b.candidate) || a.index - b.index)\n    .map((entry) => entry.candidate);\n}\n\n/** Body of the GQL `PlaybackAccessToken` request. */\nfunction tokenPayload(channel, playerType, platform = \"web\") {\n  return {\n    operationName: \"PlaybackAccessToken\",\n    variables: {\n      isLive: true,\n      login: channel,\n      isVod: false,\n      vodID: \"\",\n      playerType,\n      platform,\n    },\n    extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } },\n  };\n}\n\n/** Master playlist URL for a given signature/token pair. */\nfunction usherUrl(channel, signature, token, random = Math.random) {\n  const params = new URLSearchParams({\n    sig: signature,\n    token,\n    allow_source: \"true\",\n    allow_audio_only: \"true\",\n    fast_bread: \"true\",\n    player_backend: \"mediaplayer\",\n    playlist_include_framerate: \"true\",\n    reassignments_supported: \"true\",\n    supported_codecs: \"avc1\", // HEVC breaks a hot swap\n    transcode_mode: \"cbr_v1\",\n    p: String(1_000_000 + Math.floor(random() * 9_000_000)),\n  });\n  return `${USHER_URL.replace(\"{channel}\", encodeURIComponent(channel))}?${params}`;\n}\n\n/**\n * Headers for backup requests: nothing beyond the public Client-ID.\n *\n * Two reasons, the second being the important one.\n *\n * 1. It works better. Measured on one channel, same instant, same preroll: with\n *    identity headers, 11 candidates out of 11 came back stitched; without them,\n *    a clean feed was found. Twitch ties the request to the same viewer and\n *    serves the same campaign everywhere — whereas a backup feed exists precisely\n *    to look like a *different* viewer.\n * 2. No secret is moved. Harvesting the page's OAuth token to pass it to the\n *    worker would mean broadcasting it on a same-origin channel.\n *\n * Accepted cost: channels that refuse an anonymous token get no backup feed.\n */\nfunction headers() {\n  return {\n    \"Client-ID\": CLIENT_ID,\n    \"Content-Type\": \"text/plain;charset=UTF-8\",\n  };\n}\n\n/** Extract `{value, signature}` from a GQL response, or null. */\nfunction readToken(text) {\n  let payload;\n  try {\n    payload = JSON.parse(text);\n  } catch {\n    return null;\n  }\n  const entries = Array.isArray(payload) ? payload : [payload];\n  for (const entry of entries) {\n    if (!entry || typeof entry !== \"object\") continue;\n    const data = entry.data || {};\n    const token = data.streamPlaybackAccessToken || data.videoPlaybackAccessToken;\n    if (token && token.value && token.signature) {\n      return { value: token.value, signature: token.signature };\n    }\n  }\n  return null;\n}\n\n/**\n * Pick the backup rendition closest to the one the player is reading.\n * HEVC is always excluded: changing codec family mid-stream breaks the decoder.\n */\nfunction pickVariant(variants, wanted) {\n  const usable = variants.filter((v) => !v.isHevc && !isHevc(v.codecs));\n  if (!usable.length) return null;\n  if (wanted) {\n    const exact = usable.filter((v) => v.resolution === wanted.resolution);\n    if (exact.length) return exact[0];\n    // Otherwise the best rendition below the requested one.\n    const lower = usable.filter((v) => v.bandwidth <= wanted.bandwidth);\n    if (lower.length) return lower.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));\n  }\n  return usable.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));\n}\n\nfunction cleanStream(channel, label, variant, media, master) {\n  return {\n    channel,\n    playerType: label,\n    mediaUrl: variant.url,\n    variant,\n    body: media,\n    master,\n    quality: qualityLabel(variant),\n  };\n}\n\n/** Full chain for one candidate. Never rejects. */\nasync function tryCandidate(candidate, channel, hdrs, fetcher, wanted) {\n  const label = candidateLabel(candidate);\n  try {\n    const gql = await fetcher(\n      \"POST\",\n      GQL_URL,\n      hdrs,\n      JSON.stringify(tokenPayload(channel, candidate.playerType, candidate.platform)),\n    );\n    if (gql.status !== 200) return { candidate, stream: null, reason: `gql HTTP ${gql.status}` };\n\n    const token = readToken(gql.text);\n    if (!token) return { candidate, stream: null, reason: \"gql returned no token\" };\n\n    const master = await fetcher(\"GET\", usherUrl(channel, token.signature, token.value), null, null);\n    if (master.status !== 200) {\n      return { candidate, stream: null, reason: `usher HTTP ${master.status}` };\n    }\n\n    const variant = pickVariant(parseVariants(master.text), wanted);\n    if (!variant) return { candidate, stream: null, reason: \"no usable rendition\" };\n\n    const media = await fetcher(\"GET\", variant.url, null, null);\n    if (media.status !== 200) {\n      return { candidate, stream: null, reason: `media HTTP ${media.status}` };\n    }\n    if (hasAdMarkers(media.text)) {\n      return { candidate, stream: null, reason: \"feed is stitched too\" };\n    }\n\n    return {\n      candidate,\n      stream: cleanStream(channel, label, variant, media.text, master.text),\n      reason: \"\",\n    };\n  } catch (error) {\n    return { candidate, stream: null, reason: String((error && error.message) || error) };\n  }\n}\n\n/**\n * Find an ad-free media playlist, trying every candidate in parallel.\n *\n * Sequentially each candidate costs ~0.65s, so the first clean feed arrived\n * about 2s into the break — two seconds during which the player only received a\n * stripped playlist. The result is still the *first clean candidate in list\n * order*, so parallelism does not degrade the choice.\n *\n * Never rejects: every failure is recorded in `attempts`, and the verdict of\n * every candidate — winner included, and those that would also have worked — in\n * `outcomes`, which is what the ranking learns from. `attempts` stops at the\n * winner on purpose: it exists to explain a failure, not to score.\n */\nasync function findCleanStream(\n  channel,\n  fetcher,\n  wanted = null,\n  candidates = BACKUP_CANDIDATES,\n) {\n  const result = { stream: null, attempts: [], outcomes: [] };\n  if (!candidates.length) return result;\n  const hdrs = headers();\n\n  const verdicts = await Promise.all(\n    candidates.map((c) => tryCandidate(c, channel, hdrs, fetcher, wanted)),\n  );\n\n  for (const verdict of verdicts) {\n    result.outcomes.push([candidateLabel(verdict.candidate), Boolean(verdict.stream)]);\n  }\n\n  for (const verdict of verdicts) {\n    if (verdict.stream) {\n      result.stream = verdict.stream;\n      return result;\n    }\n    result.attempts.push([candidateLabel(verdict.candidate), verdict.reason]);\n  }\n  return result;\n}\n\n/**\n * Derive a clean feed from a master playlist already obtained, for another\n * rendition of the same channel.\n *\n * The player polls several renditions at once; without this, each would replay\n * the whole chain for every candidate. The absence of ads is re-checked anyway,\n * since the ad server can catch one rendition and not another.\n */\nasync function cleanStreamFromMaster(channel, label, master, fetcher, wanted = null) {\n  const variant = pickVariant(parseVariants(master), wanted);\n  if (!variant) return null;\n  let media;\n  try {\n    media = await fetcher(\"GET\", variant.url, null, null);\n  } catch {\n    return null;\n  }\n  if (media.status !== 200 || hasAdMarkers(media.text)) return null;\n  return cleanStream(channel, label, variant, media.text, master);\n}\n\n/* src/lib/blocker.js */\n/**\n * Decision engine: what to serve the player for every media playlist it asks for.\n *\n * Three outcomes, in order of preference:\n *\n *   1. serve an ad-free feed obtained for a different `playerType` (a swap);\n *   2. strip the ad segments, when live content remains in the playlist;\n *   3. serve the original playlist untouched, when stripping would empty it —\n *      an empty live playlist sends the player to the streamer's offline screen.\n *\n * Case 3 is where a browser extension can do what a proxy cannot: ask the player\n * to start a new playback session, giving Twitch another chance to hand out an\n * unstitched stream. That reload is instrumented (`reloads`, `usefulReloads`) so\n * its value is measured rather than assumed.\n *\n * Pure module: no network, no DOM. Everything goes through injected functions.\n */\n\n\n\n\n/** How long a backup feed stays valid, in seconds. */\nconst BACKUP_TTL = 240;\n\n/**\n * Back-off after a failed search, doubling on each consecutive failure.\n *\n * One search costs up to eleven candidates times three requests. Repeated every\n * five seconds through a long unblockable break, that was in the order of 400\n * requests per minute for an outcome already known.\n */\nconst BACKOFF_BASE = 5;\nconst BACKOFF_MAX = 60;\n\nfunction backoffAfter(failures) {\n  return Math.min(BACKOFF_BASE * 2 ** Math.max(0, failures - 1), BACKOFF_MAX);\n}\n\n/** Very short cache of a backup body: the player polls faster than Twitch updates. */\nconst BACKUP_BODY_TTL = 1.5;\n/** Reuse of an already-obtained master for the channel's other renditions. */\nconst MASTER_TTL = 12;\n/** Past this, warn that the player is sitting on a loading screen. */\nconst STRIP_WARN = 12;\n/** How long the player's request is held while the first search runs. */\nconst FIRST_WAIT = 2.5;\n/** A playlist URL not seen for this long is considered abandoned. */\nconst URL_STALE = 12;\n/** Upper bound on per-URL state, for multi-hour sessions. */\nconst MAX_URLS = 64;\n/** Past this, a memorised backup body has no chance of being useful. */\nconst BODY_STALE = 30;\n\n/** Never two reloads back to back: that would be an unbearable loop. */\nconst RELOAD_COOLDOWN = 25;\n/** And never more than two attempts for the same break. */\nconst RELOAD_MAX_PER_BREAK = 2;\n\nconst DEFAULT_OPTIONS = {\n  block: true,\n  swap: true,\n  dropHevc: true,\n  reloadPlayer: true,\n  // On by default: the degraded list is only consulted after the nine\n  // source-quality candidates, and 480p beats a full ad break.\n  lowQuality: true,\n};\n\n/**\n * Await a promise, but for at most `seconds`. The timer is cancelled as soon as\n * the promise settles, so no 2.5s timer is left pending on every break.\n */\nfunction raceWithDeadline(promise, seconds) {\n  return new Promise((resolve) => {\n    const timer = setTimeout(resolve, seconds * 1000);\n    const done = () => {\n      clearTimeout(timer);\n      resolve();\n    };\n    promise.then(done, done);\n  });\n}\n\nfunction createBlocker({\n  fetcher,\n  now = () => Date.now() / 1000,\n  onReload = () => false,\n  onEvent = () => {},\n  options = {},\n} = {}) {\n  const opt = { ...DEFAULT_OPTIONS, ...options };\n\n  /**\n   * All state for one playlist URL, in a single record.\n   *\n   * This used to be thirteen parallel maps on the same key. Each had to be\n   * remembered when pruning and when a break ended, and two had already been\n   * missed — state outliving what it described. One map makes that impossible.\n   */\n  const states = new Map();\n  /** Backup bodies, keyed by *backup* URL rather than playlist URL. */\n  const backupBodies = new Map();\n  /** In-flight searches; self-cleaning, so never any residue to prune. */\n  const searches = new Map();\n\n  function stateOf(url) {\n    let state = states.get(url);\n    if (!state) {\n      state = {\n        seenAt: 0,\n        inBreak: false,\n        variant: null, // {channel, variant}\n        backup: null, // {url, label, obtainedAt, quality}\n        serving: \"origin\",\n        failedTypes: null, // Map(label -> timestamp)\n        blockedUntil: 0,\n        failures: 0,\n        strippingSince: 0,\n        stripWarned: false,\n        letThroughWarned: false,\n        counted: null, // {channel, letThrough}\n        sequenceOffset: 0,\n        lastSequence: -1,\n        // Served sequence number of the segment the last source switch landed\n        // on, for as long as it stays in the window. -1 once it has scrolled\n        // out, or before anything was switched.\n        discontinuityAt: -1,\n      };\n      states.set(url, state);\n    }\n    return state;\n  }\n\n  /** Reset what only makes sense during a break. */\n  function endOfBreak(state) {\n    state.backup = null;\n    state.failedTypes = null;\n    state.strippingSince = 0;\n    state.stripWarned = false;\n    state.letThroughWarned = false;\n    state.counted = null;\n    state.blockedUntil = 0;\n    // New break, new chance: start again from a short back-off.\n    state.failures = 0;\n  }\n\n  // -- session-wide state -------------------------------------------------\n  let currentChannel = \"\";\n  let cleanMaster = null; // {channel, label, master, obtainedAt}\n  const tally = new Map(); // channel -> [blocked, letThrough]\n\n  const counters = {\n    breaks: 0,\n    swaps: 0,\n    strippedSegments: 0,\n    adsLetThrough: 0,\n    failedSearches: 0,\n    reloads: 0,\n    usefulReloads: 0,\n    lastSearchMs: 0,\n  };\n  let lastBreak = null;\n  let adTimeTotal = 0;\n  let lastTick = null;\n  const sessionStart = now();\n\n  let lastReload = -Infinity;\n  let reloadsThisBreak = 0;\n  /** True while waiting to see whether a reload achieved anything. */\n  let watchingReload = false;\n\n  function log(level, message) {\n    onEvent({ type: \"log\", level, message });\n  }\n\n  /**\n   * Learned order of the backup sources, supplied by the service worker.\n   *\n   * It is advice, not a filter: nothing is ever removed from the list, only\n   * moved. A candidate the ranking has never heard of stays where the\n   * hand-picked list put it.\n   */\n  let order = [];\n\n  function setRanking(labels) {\n    const next = Array.isArray(labels) ? labels.filter((l) => typeof l === \"string\") : [];\n    if (next.join(\"|\") === order.join(\"|\")) return false;\n    order = next;\n    return true;\n  }\n\n  function candidates() {\n    const list = opt.lowQuality\n      ? [...BACKUP_CANDIDATES, ...LOW_QUALITY_CANDIDATES]\n      : BACKUP_CANDIDATES;\n    return orderCandidates(list, order);\n  }\n\n  /** Candidates still worth trying for this URL during the current break. */\n  function remainingCandidates(url) {\n    const failed = stateOf(url).failedTypes;\n    if (!failed || !failed.size) return candidates();\n    const left = candidates().filter((c) => !failed.has(candidateLabel(c)));\n    // All burned: give them another chance rather than trying nothing.\n    return left.length ? left : candidates();\n  }\n\n  /**\n   * Bound the per-URL state. A multi-hour session goes through many playlist\n   * URLs: quality changes, channel changes, CDN rotations.\n   */\n  function prune() {\n    // Backup bodies are keyed by backup URL, so they cannot follow a playlist's\n    // fate and are bounded by age instead.\n    const t = now();\n    for (const [key, body] of backupBodies) {\n      if (t - body.at > BODY_STALE) backupBodies.delete(key);\n    }\n\n    if (states.size <= MAX_URLS) return;\n    const sorted = [...states.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);\n    for (const [url] of sorted.slice(0, states.size - MAX_URLS)) states.delete(url);\n  }\n\n  /** URLs the player is still actively polling. */\n  function live() {\n    const t = now();\n    return [...states.entries()].filter(([, s]) => t - s.seenAt < URL_STALE).map(([url]) => url);\n  }\n\n  /**\n   * Keep the per-channel tally: one entry per break and per URL.\n   *\n   * A break can change verdict along the way — let through at first, then\n   * replaced once a clean feed is found. Counting both would make the table show\n   * more events than there were breaks, so the previous verdict is corrected.\n   */\n  function count(url, letThrough) {\n    const state = stateOf(url);\n    const channel = (state.variant && state.variant.channel) || currentChannel;\n    if (!channel) return;\n\n    const before = state.counted;\n    if (before && before.channel === channel && before.letThrough === letThrough) return;\n\n    if (before) {\n      const previous = tally.get(before.channel);\n      if (previous) {\n        const column = before.letThrough ? 1 : 0;\n        previous[column] = Math.max(0, previous[column] - 1);\n      }\n    }\n\n    const entry = tally.get(channel) || [0, 0];\n    entry[letThrough ? 1 : 0] += 1;\n    tally.set(channel, entry);\n    state.counted = { channel, letThrough };\n  }\n\n  /**\n   * Serve `body`, flagging any source change to the player.\n   *\n   * `source` identifies the precise feed, not its category: two successive\n   * backup feeds are two Twitch sessions, hence two timelines.\n   *\n   * It also keeps the media sequence strictly increasing. Every session has its\n   * own numbering — a preroll even restarts at 0 — and a live playlist whose\n   * sequence goes backwards is stale to a player: it waits instead of playing,\n   * which looks like a load that never finishes when the break ends.\n   */\n  function serve(url, body, source) {\n    let out = body;\n    const state = stateOf(url);\n    const sourceSequence = readMediaSequence(body);\n\n    if (state.serving !== source) {\n      state.serving = source;\n      state.sequenceOffset = state.lastSequence >= 0 ? state.lastSequence + 1 - sourceSequence : 0;\n      // Remember WHICH segment the boundary falls on, not just that there is\n      // one. The tag used to be written on the single poll where the source\n      // changed and never again: on the next poll the window had slid by one,\n      // the same segment was still there, and the discontinuity in front of it\n      // had vanished. A playlist is a sliding window over a fixed timeline, so\n      // a segment that follows a discontinuity must go on following it for as\n      // long as it is listed — a player that sees one appear and disappear\n      // before the same segment can no longer place what comes after.\n      state.discontinuityAt = sourceSequence + state.sequenceOffset;\n      log(\"info\", `switched source -> ${source.startsWith(\"backup:\") ? \"replacement feed\" : \"original feed\"} (discontinuity flagged)`);\n    }\n\n    const served = sourceSequence + state.sequenceOffset;\n\n    if (state.discontinuityAt >= 0) {\n      const at = state.discontinuityAt - served;\n      if (at < 0) state.discontinuityAt = -1; // scrolled out of the window\n      else out = markDiscontinuity(out, at);\n    }\n\n    if (state.sequenceOffset !== 0) out = writeMediaSequence(out, served);\n    state.lastSequence = Math.max(state.lastSequence, served + Math.max(0, countSegments(body) - 1));\n    return out;\n  }\n\n  /**\n   * Ask the player to start a new playback session.\n   *\n   * Tightly bounded: a reload is visible to the user (the picture restarts), so\n   * it must stay rare and only happen where the alternative is a full ad break.\n   */\n  function requestReload(reason) {\n    if (!opt.reloadPlayer) return false;\n    const t = now();\n    if (t - lastReload < RELOAD_COOLDOWN) return false;\n    if (reloadsThisBreak >= RELOAD_MAX_PER_BREAK) return false;\n    let accepted = false;\n    try {\n      accepted = onReload(reason) !== false;\n    } catch {\n      accepted = false;\n    }\n    if (!accepted) return false;\n    lastReload = t;\n    reloadsThisBreak += 1;\n    counters.reloads += 1;\n    watchingReload = true;\n    log(\"warning\", `player reload requested (${reason})`);\n    return true;\n  }\n\n  // -- master playlist ----------------------------------------------------\n\n  /**\n   * Record the renditions and drop HEVC ones.\n   *\n   * Recording happens *before* dropping: the player may already sit on an HEVC\n   * rendition from an earlier master, and we must recognise it to avoid\n   * attempting a substitution there.\n   */\n  function onMaster(url, text, channel) {\n    if (channel) currentChannel = channel;\n    const variants = parseVariants(text);\n    for (const variant of variants) {\n      stateOf(variant.url).variant = { channel: currentChannel, variant };\n    }\n    onEvent({ type: \"master\", channel: currentChannel, qualities: variants.map(qualityLabel) });\n    if (!opt.dropHevc) return text;\n    const { text: out, removed } = stripHevcVariants(text);\n    if (removed) {\n      log(\"info\", `dropped ${removed} HEVC rendition(s) — no HEVC replacement feed exists`);\n    }\n    return out;\n  }\n\n  // -- searching for a clean feed ----------------------------------------\n\n  async function search(url) {\n    const state = stateOf(url);\n    const channel = (state.variant && state.variant.channel) || currentChannel;\n    const wanted = state.variant ? state.variant.variant : null;\n    if (!channel) return null;\n\n    const started = now();\n\n    // A master already obtained covers the channel's other renditions: one\n    // request instead of the whole chain for every candidate.\n    if (cleanMaster && cleanMaster.channel === channel && started - cleanMaster.obtainedAt < MASTER_TTL) {\n      const feed = await cleanStreamFromMaster(channel, cleanMaster.label, cleanMaster.master, fetcher, wanted);\n      if (feed) {\n        state.backup = {\n          url: feed.mediaUrl,\n          label: feed.playerType,\n          obtainedAt: now(),\n          quality: feed.quality,\n        };\n        counters.lastSearchMs = Math.round((now() - started) * 1000);\n        return feed;\n      }\n      cleanMaster = null;\n    }\n\n    const result = await findCleanStream(channel, fetcher, wanted, remainingCandidates(url));\n    counters.lastSearchMs = Math.round((now() - started) * 1000);\n\n    if (!result.stream) {\n      counters.failedSearches += 1;\n      state.failures += 1;\n      const wait = backoffAfter(state.failures);\n      state.blockedUntil = now() + wait;\n      log(\"warning\", `no clean feed for ${channel} (retry in ${wait}s): ${result.attempts.map(([l, r]) => `${l} (${r})`).join(\", \")}`);\n      onEvent({\n        type: \"search\",\n        channel,\n        found: false,\n        attempts: result.attempts,\n        outcomes: result.outcomes,\n      });\n      return null;\n    }\n\n    const feed = result.stream;\n    state.failures = 0;\n    cleanMaster = { channel, label: feed.playerType, master: feed.master, obtainedAt: now() };\n    state.backup = {\n      url: feed.mediaUrl,\n      label: feed.playerType,\n      obtainedAt: now(),\n      quality: feed.quality,\n    };\n    log(\"info\", `clean feed found via ${feed.playerType} in ${counters.lastSearchMs}ms (${feed.quality})`);\n    onEvent({\n      type: \"search\",\n      channel,\n      found: true,\n      label: feed.playerType,\n      quality: feed.quality,\n      outcomes: result.outcomes,\n    });\n    return feed;\n  }\n\n  /** Deduplicate searches: the player polls several renditions at once. */\n  function startSearch(url) {\n    if (searches.has(url)) return searches.get(url);\n    if (now() < stateOf(url).blockedUntil) return null;\n    const promise = search(url)\n      .catch(() => null)\n      .finally(() => searches.delete(url));\n    searches.set(url, promise);\n    return promise;\n  }\n\n  /** Serve the memorised backup feed, or null if there is none (any more). */\n  async function serveBackup(url) {\n    const state = stateOf(url);\n    const entry = state.backup;\n    if (!entry) return null;\n    if (now() - entry.obtainedAt > BACKUP_TTL) {\n      state.backup = null;\n      return null;\n    }\n\n    let body;\n    const fresh = backupBodies.get(entry.url);\n    if (fresh && now() - fresh.at < BACKUP_BODY_TTL) {\n      body = fresh.body;\n    } else {\n      let response;\n      try {\n        response = await fetcher(\"GET\", entry.url, null, null);\n      } catch {\n        response = { status: 0, text: \"\" };\n      }\n      if (response.status !== 200 || !response.text.startsWith(\"#EXTM3U\")) {\n        state.backup = null;\n        backupBodies.delete(entry.url);\n        return null;\n      }\n      body = response.text;\n      backupBodies.set(entry.url, { at: now(), body });\n    }\n\n    if (hasAdMarkers(body)) {\n      // The backup feed was caught by the ad server. Drop it, and remember the\n      // playerType so it is not offered again during this break.\n      state.backup = null;\n      backupBodies.delete(entry.url);\n      if (!state.failedTypes) state.failedTypes = new Map();\n      state.failedTypes.set(entry.label, now());\n      log(\"info\", `replacement feed caught by ads (playerType=${entry.label})`);\n      return null;\n    }\n\n    state.strippingSince = 0;\n    state.stripWarned = false;\n    count(url, false);\n    counters.swaps += 1;\n    if (watchingReload) {\n      counters.usefulReloads += 1;\n      watchingReload = false;\n    }\n    onEvent({ type: \"swap\", label: entry.label, quality: entry.quality });\n    return serve(url, body, `backup:${entry.url}`);\n  }\n\n  // -- fallback: strip the ad segments ------------------------------------\n\n  function strip(url, text) {\n    const state = stateOf(url);\n    const { text: cleaned, removed } = stripAds(text);\n\n    // If stripping leaves NO segment — a preroll, or a fully advertised break —\n    // we do not serve an empty playlist: the player concludes the stream does\n    // not exist and switches to the streamer's offline screen, which needs a\n    // manual reload. Serving the ad is the lesser evil; the page hides it.\n    if (removed && parseMedia(cleaned).segments.length === 0) {\n      counters.adsLetThrough += 1;\n      count(url, true);\n      if (!state.letThroughWarned) {\n        state.letThroughWarned = true;\n        log(\"warning\", \"no clean feed and stripping would empty the playlist — letting the ad through to keep the player alive\");\n        onEvent({ type: \"adLetThrough\", duration: lastBreak ? lastBreak.duration : 0 });\n      }\n      requestReload(\"whole playlist is ads\");\n      return serve(url, text, \"origin\");\n    }\n\n    counters.strippedSegments += removed;\n\n    if (!state.strippingSince) state.strippingSince = now();\n    const elapsed = now() - state.strippingSince;\n    if (elapsed > STRIP_WARN && !state.stripWarned) {\n      state.stripWarned = true;\n      log(\"warning\", `no replacement feed for ${Math.round(elapsed)}s — the player is stuck loading`);\n      requestReload(\"player frozen with no replacement feed\");\n    }\n\n    return serve(url, cleaned, \"origin\");\n  }\n\n  // -- ad break -----------------------------------------------------------\n\n  async function handleBreak(url, text) {\n    if (!opt.swap) return strip(url, text);\n\n    const known = stateOf(url).variant;\n    if (known && known.variant.isHevc) {\n      // No backup feed exists in HEVC: substituting would break the decoder.\n      return strip(url, text);\n    }\n\n    const cached = await serveBackup(url);\n    if (cached !== null) return cached;\n\n    // First poll of the break, nothing cached. Rather than immediately serving a\n    // stripped playlist, give the search a short moment (~600ms in practice).\n    // The player has buffer and tolerates the wait better than a gap.\n    const running = startSearch(url);\n    if (running) {\n      await raceWithDeadline(running, FIRST_WAIT);\n      const found = await serveBackup(url);\n      if (found !== null) return found;\n    }\n\n    return strip(url, text);\n  }\n\n  // -- media playlist -----------------------------------------------------\n\n  async function onMedia(url, text) {\n    const state = stateOf(url);\n    state.seenAt = now();\n    const playlist = parseMedia(text);\n    const wasInBreak = state.inBreak;\n    const isInBreak = isAdBreak(playlist);\n\n    if (isInBreak && !wasInBreak) {\n      counters.breaks += 1;\n      reloadsThisBreak = 0;\n      const first = playlist.adBreaks[0];\n      lastBreak = {\n        at: now(),\n        // `roll`, never `type`: two names for the same thing once silently\n        // overwrote the event type.\n        roll: rollType(playlist) || \"?\",\n        duration: first ? first.duration : 0,\n        spots: first ? first.podLength : 0,\n      };\n      log(\"warning\", `>> AD #${counters.breaks} (${lastBreak.roll}, ${Math.round(lastBreak.duration)}s, pod=${lastBreak.spots})`);\n      onEvent({ type: \"break\", roll: lastBreak.roll, duration: lastBreak.duration, spots: lastBreak.spots });\n    } else if (wasInBreak && !isInBreak) {\n      log(\"info\", \"<< ad break over — back to live\");\n      endOfBreak(state);\n      // Live came back on its own; the reload, if any, may have nothing to do\n      // with it, so stop watching.\n      watchingReload = false;\n      onEvent({ type: \"breakOver\" });\n    }\n\n    // Cumulated ad time. Only URLs the player still polls are considered:\n    // otherwise one abandoned mid-break would stay flagged forever and keep the\n    // counter running.\n    const t = now();\n    if (lastTick !== null && live().some((u) => stateOf(u).inBreak)) {\n      adTimeTotal += t - lastTick;\n    }\n    lastTick = t;\n\n    state.inBreak = isInBreak;\n    prune();\n\n    if (isInBreak && opt.block) return handleBreak(url, text);\n    // Outside a break we still go through `serve`: it flags the return to the\n    // original feed and, above all, keeps the sequence numbering continuous.\n    if (opt.block) return serve(url, text, \"origin\");\n    return text;\n  }\n\n  /**\n   * Turn the engine off, or back on, without rebuilding it.\n   *\n   * Off is a genuine pass-through: every playlist is handed back exactly as it\n   * arrived. The switch exists so that a player misbehaving for any reason can\n   * be cleared of suspicion in one click, rather than by uninstalling.\n   */\n  function setEnabled(on) {\n    opt.block = on !== false;\n  }\n\n  /**\n   * Channel name supplied by the page.\n   *\n   * Without it everything depended on having seen the master go by, which the\n   * player does not always re-request (cached response, in-app navigation). We\n   * then knew about the break without being able to search for a backup feed.\n   */\n  function setChannel(channel) {\n    const clean = String(channel || \"\").trim().toLowerCase();\n    if (!clean || clean === currentChannel) return;\n    currentChannel = clean;\n    // Channel change: what we knew about the previous one no longer applies.\n    cleanMaster = null;\n  }\n\n  // -- telemetry ----------------------------------------------------------\n\n  function stats() {\n    const active = live();\n    const t = now();\n    const frozen = Math.max(\n      0,\n      ...active.map((url) => (stateOf(url).strippingSince ? t - stateOf(url).strippingSince : 0)),\n    );\n    const inBreak = active.filter((url) => stateOf(url).inBreak);\n\n    // The quality the player is asking for *right now*: the most recently seen\n    // URL. Walking insertion order picked an arbitrary active rendition.\n    let requested = \"\";\n    for (const url of [...active].sort((a, b) => stateOf(b).seenAt - stateOf(a).seenAt)) {\n      const known = stateOf(url).variant;\n      if (known) {\n        requested = qualityLabel(known.variant);\n        break;\n      }\n    }\n\n    const served = new Set();\n    const types = new Set();\n    for (const url of active) {\n      const entry = stateOf(url).backup;\n      if (!entry) continue;\n      served.add(entry.quality);\n      types.add(entry.label);\n    }\n\n    return {\n      frozenFor: frozen > STRIP_WARN ? Math.round(frozen * 10) / 10 : 0,\n      breaks: counters.breaks,\n      swaps: counters.swaps,\n      strippedSegments: counters.strippedSegments,\n      inBreak: inBreak.length > 0,\n      backupFeeds: [...types].sort(),\n      qualityServed: [...served].sort(),\n      watchedFor: Math.round(t - sessionStart),\n      adTimeAvoided: Math.round(adTimeTotal),\n      qualityRequested: requested,\n      failedSearches: counters.failedSearches,\n      channel: currentChannel,\n      lastBreak,\n      blocking: opt.block,\n      adsLetThrough: counters.adsLetThrough,\n      tally: Object.fromEntries([...tally.entries()].map(([c, v]) => [c, [...v]])),\n      adNotBlocked: inBreak.some((url) => stateOf(url).letThroughWarned),\n      reloads: counters.reloads,\n      usefulReloads: counters.usefulReloads,\n      // Current break, for the countdown: `startedAt` lets the display tick on\n      // its own between two reports instead of jumping every 2s.\n      currentBreak:\n        inBreak.length && lastBreak\n          ? {\n              roll: lastBreak.roll,\n              duration: lastBreak.duration,\n              spots: lastBreak.spots,\n              startedAt: lastBreak.at,\n            }\n          : null,\n      // Internal state size: the only way to check from outside that a long\n      // session stays bounded.\n      trackedUrls: states.size,\n      cachedBodies: backupBodies.size,\n    };\n  }\n\n  return { onMaster, onMedia, setChannel, setEnabled, setRanking, stats, options: opt };\n}\n\n/* src/worker/entry.js */\n/**\n * The part that runs *inside* the Twitch player's worker.\n *\n * The player does not fetch its playlists from the main thread: it uses the\n * `amazon-ivs-wasmworker` worker. Hooking `window.fetch` therefore sees nothing,\n * which is why `page/hook.js` rebuilds the worker blob with this code prepended.\n *\n * Two things learned from real traffic, both invisible offline:\n *\n * 1. Classifying by URL does not work. The master is served from\n *    `/api/v2/channel/hls/<channel>.m3u8`, and media playlists from\n *    `/v1/playlist/<blob>` — with no `.m3u8` extension. Filtering on `.m3u8`\n *    lets through exactly what needs intercepting, so classification is by\n *    content.\n * 2. Never post to the worker's own message channel. Sending it an unknown\n *    message freezes the player on an endless loading screen. All communication\n *    goes through a private `BroadcastChannel` whose name the page injects.\n */\n\n\n\n\n/** Master playlist: both `/api/channel/hls/` and `/api/v2/channel/hls/`. */\nconst MASTER_RE = /\\/channel\\/hls\\/([^./?]+)/;\n\n/** Worth reading: both playlist families, never segments. */\nconst PLAYLIST_RE = /\\/channel\\/hls\\/|\\/v1\\/playlist\\/|\\.m3u8/;\nconst SEGMENT_RE = /\\/v1\\/segment\\//;\n\nconst HLS_MIME = \"application/vnd.apple.mpegurl\";\n\n/** How often telemetry is broadcast. */\nconst TELEMETRY_MS = 2000;\n\n/**\n * Upper bound on a single backup request.\n *\n * Nothing else bounds them. The search runs every candidate through\n * `Promise.all`, so one connection that never answers holds the whole search,\n * and the player's own playlist request is waiting behind it — its buffer\n * drains and the picture stops.\n *\n * The engine's own guard, `FIRST_WAIT`, is a `setTimeout`, and Chrome throttles\n * timers in a hidden page: in a background tab that guard can stretch far past\n * the 2.5s it promises. This one is enforced by the platform, not by a timer we\n * own, so it holds wherever the tab is. A full chain of three requests measures\n * about 1.3s in practice, which leaves ample headroom.\n */\nconst REQUEST_TIMEOUT_MS = 4000;\n\n/**\n * Past this, the hook held the player's own request long enough to matter.\n *\n * The player polls every two seconds and has only a few seconds of buffer, so\n * anything above this is worth a line in the log — it is the one measurement\n * that separates \"the extension is holding the response\" from \"the stream\n * stopped for its own reasons\", and the log said nothing at all about a freeze\n * that only happened in a background tab.\n */\nconst HOLD_WARN_MS = 3000;\n\n/**\n * Past this without a single playlist request, the player has stopped asking.\n *\n * It polls every two seconds per rendition, so this much silence is not a lull.\n * It is the other half of the question the log could not answer: whether a\n * frozen picture means we stopped serving, or the player stopped requesting.\n */\nconst STALL_MS = 10000;\n\n/** `AbortSignal.timeout` where it exists, nothing where it does not. */\nfunction deadline(ms = REQUEST_TIMEOUT_MS) {\n  try {\n    return AbortSignal.timeout(ms);\n  } catch {\n    return undefined;\n  }\n}\n\nfunction urlOf(input) {\n  if (typeof input === \"string\") return input;\n  if (input && typeof input.url === \"string\") return input.url;\n  return \"\";\n}\n\n/** Channel name, taken from the master playlist path. */\nfunction channelFromUrl(url) {\n  const found = MASTER_RE.exec(url || \"\");\n  return found ? decodeURIComponent(found[1]).toLowerCase() : \"\";\n}\n\n/**\n * Is this response body worth reading?\n *\n * Deliberately broad: the *content* decides master versus media. Segments are\n * excluded explicitly — they are by far the most frequent requests, and reading\n * their bodies would cost a lot for nothing.\n */\nfunction isPlaylist(url) {\n  return PLAYLIST_RE.test(url) && !SEGMENT_RE.test(url);\n}\n\n/**\n * Hand the player a playlist, keeping everything Twitch said about it.\n *\n * The body is ours; the status and the headers are not. An earlier version\n * built a bare 200 with two headers of its own, discarding the rest — caching\n * directives, `Date`, the low-latency hints the player reads to schedule its\n * next poll. Replacing a playlist is no reason to rewrite its envelope.\n */\nfunction playlistResponse(text, source, from) {\n  const headers = new Headers(from ? from.headers : undefined);\n  headers.set(\"Content-Type\", HLS_MIME);\n  headers.set(\"X-Ads-Remove-Source\", source);\n  return new Response(text, {\n    status: from ? from.status : 200,\n    statusText: from ? from.statusText : \"OK\",\n    headers,\n  });\n}\n\n/**\n * Install the hook in a worker scope.\n *\n * `scope` is `self` in production; tests pass a fake scope, which is what makes\n * this file verifiable without a browser.\n */\nfunction installHook(scope, options = {}) {\n  const originalFetch = scope.fetch.bind(scope);\n  const token = options.token || scope.__ADS_REMOVE_TOKEN || \"shared\";\n  // Identifier for THIS worker. The player creates several and recreates one on\n  // every reload; without distinct ids their reports overwrite each other and\n  // the counters restart from zero — exactly what aggregation exists to avoid.\n  const wid = options.wid || `w${Math.random().toString(36).slice(2, 8)}`;\n\n  // The off switch. False makes the hook a pass-through: no body is read, no\n  // telemetry is sent, and the player gets byte-for-byte what Twitch returned.\n  let enabled = options.enabled !== false;\n\n  // Whether the tab is in the background, pushed down by the page: a worker has\n  // no `document` to ask. Only used to annotate the log — a freeze that happens\n  // only when hidden is a different animal from one that happens anywhere.\n  let hidden = false;\n\n  /** When the player last asked for a playlist, and whether we said so. */\n  let lastPoll = 0;\n  let stallReported = false;\n\n  // Private channel. Never `scope.postMessage`, which belongs to the player. The\n  // name carries a per-page token so another Twitch tab does not receive this\n  // tab's telemetry.\n  let channel = null;\n  try {\n    channel = new scope.BroadcastChannel(`twitch-ads-remove-${token}`);\n  } catch {\n    channel = null;\n  }\n\n  const send = (message) => {\n    if (!channel) return;\n    try {\n      channel.postMessage({ ...message, wid });\n    } catch {\n      /* channel closed: not important */\n    }\n  };\n\n  const trace = (url) => {\n    if (scope.__ADS_REMOVE_TRACE) {\n      send({ key: \"ADS_Event\", event: { type: \"traceFetch\", url: url.slice(0, 100) } });\n    }\n  };\n\n  /** Engine requests go through the original fetch, never through the hook. */\n  async function fetcher(method, url, headers, body) {\n    const response = await originalFetch(url, {\n      method,\n      headers: headers || undefined,\n      body: body || undefined,\n      // No cookies on backup calls: they must look like an anonymous session.\n      credentials: \"omit\",\n      signal: deadline(),\n    });\n    return { status: response.status, text: await response.text() };\n  }\n\n  const blocker = createBlocker({\n    fetcher,\n    onReload: (reason) => {\n      send({ key: \"ADS_Reload\", reason });\n      return true;\n    },\n    onEvent: (event) => send({ key: \"ADS_Event\", event }),\n    options: options.options || {},\n  });\n\n  scope.fetch = async function hookedFetch(input, init) {\n    // First line, before anything is read or cloned: switched off must cost\n    // nothing and change nothing.\n    if (!enabled) return originalFetch(input, init);\n\n    const url = urlOf(input);\n    trace(url);\n\n    if (!isPlaylist(url)) return originalFetch(input, init);\n\n    const started = Date.now();\n    if (stallReported && lastPoll) {\n      send({\n        key: \"ADS_Event\",\n        event: { type: \"pollResumed\", after: Math.round((started - lastPoll) / 100) / 10 },\n      });\n    }\n    lastPoll = started;\n    stallReported = false;\n\n    const response = await originalFetch(input, init);\n    if (!response.ok) return response;\n\n    // Read the body ONCE, never through `clone()`.\n    //\n    // Cloning tees the stream into two branches. Both were consumed only when\n    // the playlist came back unchanged; as soon as one was replaced, the\n    // player received a response of ours and the original branch was left\n    // unread — on every poll, of every rendition, for the life of the tab.\n    // Nothing reclaims those, and the reading the engine does is exactly the\n    // reading the player needs, so there was never a second branch to justify.\n    let text;\n    try {\n      text = await response.text();\n    } catch {\n      return response;\n    }\n\n    // From here the body is consumed: the player can only be served a response\n    // built from the text, never `response` itself.\n    const held = () => {\n      const ms = Date.now() - started;\n      if (ms >= HOLD_WARN_MS) {\n        send({ key: \"ADS_Event\", event: { type: \"slowHold\", ms, hidden } });\n      }\n      return ms;\n    };\n\n    if (!text.startsWith(\"#EXTM3U\")) {\n      held();\n      return playlistResponse(text, \"passthrough\", response);\n    }\n\n    try {\n      if (isMaster(text)) {\n        const out = blocker.onMaster(url, text, channelFromUrl(url));\n        held();\n        return playlistResponse(out, out === text ? \"origin\" : \"master\", response);\n      }\n      const out = await blocker.onMedia(url, text);\n      held();\n      return playlistResponse(out, out === text ? \"origin\" : \"media\", response);\n    } catch (error) {\n      // An engine error must never break playback: hand back what Twitch sent,\n      // ads included.\n      send({ key: \"ADS_Event\", event: { type: \"error\", message: String(error && error.message) } });\n      held();\n      return playlistResponse(text, \"origin\", response);\n    }\n  };\n\n  // What the page sends down: the channel being watched, the off switch, the\n  // learned order of the backup sources, and whether the tab is visible. No\n  // credentials travel: backup requests are anonymous by construction.\n  if (channel) {\n    channel.addEventListener(\"message\", (event) => {\n      const data = event && event.data;\n      if (data && data.key === \"ADS_Channel\") blocker.setChannel(data.channel);\n      else if (data && data.key === \"ADS_Enabled\") {\n        enabled = data.enabled !== false;\n        blocker.setEnabled(enabled);\n      } else if (data && data.key === \"ADS_Ranking\") blocker.setRanking(data.order);\n      else if (data && data.key === \"ADS_Visible\") hidden = data.hidden === true;\n    });\n  }\n\n  const timer = setInterval(() => {\n    if (!enabled) return;\n    send({ key: \"ADS_Stats\", stats: blocker.stats() });\n\n    const silent = lastPoll ? Date.now() - lastPoll : 0;\n    if (silent > STALL_MS && !stallReported) {\n      stallReported = true;\n      send({\n        key: \"ADS_Event\",\n        event: { type: \"playerStopped\", after: Math.round(silent / 100) / 10, hidden },\n      });\n    }\n  }, options.telemetryMs || TELEMETRY_MS);\n\n  send({ key: \"ADS_Ready\" });\n  return {\n    blocker,\n    stop: () => {\n      clearInterval(timer);\n      if (channel) channel.close();\n    },\n  };\n}\ntry { installHook(self, { enabled: globalThis.__ADS_REMOVE_ENABLED !== false }); } catch (e) { /* not a player worker */ }\n})();";
  const TAG = "[twitch-ads-remove]";

  /** Keeps this page's channel separate from other Twitch tabs. */
  const TOKEN = Math.random().toString(36).slice(2, 10);

  /**
   * Mirror of the off switch, readable synchronously.
   *
   * The authority is `chrome.storage.local`, which this world cannot reach and
   * which is async anyway. By the time the bridge could answer, the player may
   * already have built its worker — so the bridge keeps this copy in the page's
   * own `localStorage`, and the decision to hook is taken here, before anything
   * else runs. Unset means on: a first install blocks.
   */
  const MIRROR_KEY = "twitch-ads-remove-enabled";

  function enabledAtLoad() {
    try {
      return window.localStorage.getItem(MIRROR_KEY) !== "0";
    } catch {
      return true; // storage denied by a site-data setting: behave as installed
    }
  }

  let enabled = enabledAtLoad();
  let hookInstalled = false;

  function toExtension(type, data) {
    window.postMessage({ source: "ads-remove-page", type, ...data }, window.location.origin);
  }

  // -- 1. worker hook -----------------------------------------------------

  /**
   * Read a `blob:` worker's source synchronously.
   *
   * Synchronous because a constructor cannot wait: returning before we have the
   * text would let the player start its original worker without our preamble.
   * This is only acceptable on a blob, which is already in memory — the caller
   * checks that before calling.
   */
  function workerSource(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send();
      return xhr.status === 0 || xhr.status === 200 ? xhr.responseText : "";
    } catch {
      return "";
    }
  }

  function blobWithPreamble(source) {
    // The state travels with the payload. A worker built during the instant the
    // switch is flipped would otherwise start on the default — enabled — and
    // only learn otherwise from a message sent after it had already begun.
    const header =
      `globalThis.__ADS_REMOVE_TOKEN = ${JSON.stringify(TOKEN)};\n` +
      `globalThis.__ADS_REMOVE_ENABLED = ${enabled ? "true" : "false"};\n`;
    return URL.createObjectURL(
      new Blob([`${header}${WORKER_PAYLOAD}\n;\n${source}`], { type: "text/javascript" }),
    );
  }

  const OriginalWorker = window.Worker;

  function hookWorker() {
    if (hookInstalled) return;
    hookInstalled = true;
    window.Worker = class extends OriginalWorker {
      constructor(url, workerOptions) {
        let target = url;

        // Switched off: build the worker exactly as the player asked for it.
        // The subclass cannot be removed once installed — it was put in place
        // before the player existed — so this is where "off" has to be honoured
        // for every worker created from now on, and the player builds new ones
        // constantly: on reload, on channel change, on quality change.
        if (!enabled) {
          super(url, workerOptions);
          return;
        }

        try {
          const text = typeof url === "string" ? url : String(url);
          // Blob URLs only. A synchronous read is free on a blob; on a network
          // URL the same call would block the main thread for a round trip.
          const source = text.startsWith("blob:") ? workerSource(text) : "";
          if (source) {
            target = blobWithPreamble(source);
          } else if (text) {
            // Unreadable source: load the original from our own blob instead.
            const absolute = new URL(text, window.location.href).href;
            target = blobWithPreamble(
              workerOptions && workerOptions.type === "module"
                ? `import(${JSON.stringify(absolute)});`
                : `importScripts(${JSON.stringify(absolute)});`,
            );
          }
        } catch {
          target = url;
        }

        super(target, workerOptions);
        // No `addEventListener` and no `postMessage` on this worker: its message
        // channel belongs to the player, and touching it freezes playback.
      }
    };
  }

  // -- private channel ----------------------------------------------------

  const announcedChannels = new Set();
  let channel = null;

  function openChannel() {
    try {
      channel = new BroadcastChannel(`twitch-ads-remove-${TOKEN}`);
    } catch {
      return;
    }
    channel.addEventListener("message", (event) => {
      const data = event && event.data;
      if (!data || typeof data.key !== "string") return;
      handleWorkerMessage(data);
    });
  }

  function handleWorkerMessage(data) {
    if (data.key === "ADS_Ready") {
      console.info(`${TAG} engine installed in the player worker`);
      toExtension("ready", {});
      announcedChannels.clear();
      // A reload builds a new worker, which knows none of this: say it again.
      announcedOrder = "";
      if (channel) channel.postMessage({ key: "ADS_Enabled", enabled });
      broadcastVisibility(true);
      broadcastChannelName();
      return;
    }
    if (data.key === "ADS_Stats") {
      // One line the first time a stream is seen: proof the interception works
      // end to end, without exposing a global object the page could read.
      if (data.stats && data.stats.channel && !announcedChannels.has(data.stats.channel)) {
        announcedChannels.add(data.stats.channel);
        console.info(`${TAG} tracking channel: ${data.stats.channel}`);
      }
      toExtension("stats", { stats: data.stats, wid: data.wid || "w" });
      return;
    }
    if (data.key === "ADS_Event") {
      const event = data.event || {};
      if (event.type === "adLetThrough") {
        console.info(`${TAG} ad cannot be replaced — hiding and muting`);
        hidePlayer(event.duration);
      } else if (event.type === "breakOver") {
        revealPlayer();
      } else if (event.type === "search" && !event.found) {
        console.info(`${TAG} no clean feed: ${(event.attempts || []).map((a) => a.join("=")).join(", ")}`);
      } else if (event.type === "traceFetch") {
        console.info(`${TAG} trace ${event.url}`);
      } else if (event.type === "break") {
        console.info(`${TAG} ad break ${event.roll || "?"} ${Math.round(event.duration || 0)}s (${event.spots || 0} spot(s))`);
      } else if (event.type === "swap") {
        console.info(`${TAG} feed replaced via ${event.label} (${event.quality})`);
      } else if (event.type === "slowHold") {
        console.info(
          `${TAG} playlist held ${(event.ms / 1000).toFixed(1)}s` +
            ` (tab ${event.hidden ? "hidden" : "visible"}) — the player was waiting on us`,
        );
      } else if (event.type === "playerStopped") {
        console.info(
          `${TAG} the player stopped asking for playlists ${event.after}s ago` +
            ` (tab ${event.hidden ? "hidden" : "visible"}) — nothing is being held on our side`,
        );
      } else if (event.type === "pollResumed") {
        console.info(`${TAG} the player is asking again, after ${event.after}s`);
      } else if (event.type === "error") {
        console.error(`${TAG} engine error: ${event.message}`);
      }
      toExtension("event", { event });
      return;
    }
    if (data.key === "ADS_Reload") {
      const how = reloadPlayer();
      // `console.info`, not `warn`: Chrome collects content-script warnings on
      // the extension's Errors page, where a successful reload would look like
      // a failure.
      console.info(`${TAG} reloading player (${data.reason}) -> ${how}`);
      toExtension("event", { event: { type: "reloadPerformed", reason: data.reason, how } });
    }
  }

  // -- 2. channel being watched, read from the address ---------------------

  /** twitch.tv sections that are not channels. */
  const NOT_A_CHANNEL = new Set([
    "", "directory", "videos", "settings", "wallet", "subscriptions", "inventory",
    "drops", "friends", "following", "downloads", "search", "u", "moderator",
    "popout", "team", "jobs", "turbo", "prime", "store", "p",
  ]);

  function channelFromAddress() {
    const first = window.location.pathname.split("/").filter(Boolean)[0] || "";
    const name = first.toLowerCase();
    return NOT_A_CHANNEL.has(name) ? "" : name;
  }

  let announcedChannel = "";
  function broadcastChannelName() {
    const name = channelFromAddress();
    if (!channel || !name || name === announcedChannel) return;
    announcedChannel = name;
    channel.postMessage({ key: "ADS_Channel", channel: name });
  }

  /**
   * Tell the worker whether the tab is in the background.
   *
   * A worker has no `document`, and the difference matters: a freeze that
   * happens only when hidden is a different problem from one that happens
   * anywhere. It is re-sent on every change and to every new worker.
   */
  let announcedHidden = null;
  function broadcastVisibility(force = false) {
    const now = document.visibilityState === "hidden";
    if (!channel || (now === announcedHidden && !force)) return;
    announcedHidden = now;
    channel.postMessage({ key: "ADS_Visible", hidden: now });
  }

  function watchVisibility() {
    document.addEventListener("visibilitychange", () => broadcastVisibility());
  }

  /**
   * Twitch is a single-page application: moving between channels reloads
   * nothing, so address changes are watched. Otherwise the engine would stay on
   * the previous channel.
   */
  function watchAddress() {
    const push = history.pushState;
    history.pushState = function (...args) {
      const out = push.apply(this, args);
      announcedChannel = "";
      broadcastChannelName();
      return out;
    };
    window.addEventListener("popstate", () => {
      announcedChannel = "";
      broadcastChannelName();
    });
  }

  // -- 3. player reload ---------------------------------------------------

  function findReactNode(root, matches, depth = 0) {
    if (!root || depth > 400) return null;
    try {
      if (root.stateNode && matches(root.stateNode)) return root.stateNode;
    } catch {
      /* some stateNodes throw on read */
    }
    let child = root.child;
    while (child) {
      const found = findReactNode(child, matches, depth + 1);
      if (found) return found;
      child = child.sibling;
    }
    return null;
  }

  function reactRoot() {
    const elements = document.querySelectorAll(
      '#root, [data-a-target="video-player"], .video-player, main',
    );
    for (const element of elements) {
      for (const key of Object.keys(element)) {
        if (key.startsWith("__reactContainer$")) return element[key];
        if (key === "_reactRootContainer") {
          const internal = element[key]._internalRoot || element[key];
          return internal.current || internal;
        }
      }
    }
    return null;
  }

  /**
   * Start a new playback session.
   *
   * `setSrc({isNewMediaPlayerInstance: true})` is the Twitch player's own
   * method: it requests a fresh access token and rebuilds the instance, exactly
   * as the player does when you switch channel.
   */
  function reloadPlayer() {
    try {
      const root = reactRoot();
      if (root) {
        const playerState = findReactNode(root, (n) => n && typeof n.setSrc === "function");
        if (playerState) {
          playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
          return "react:setSrc";
        }
        const player = findReactNode(
          root,
          (n) => n && n.props && n.props.mediaPlayerInstance && typeof n.setPlayerActive === "function",
        );
        if (player) {
          player.setPlayerActive(false);
          player.setPlayerActive(true);
          return "react:setPlayerActive";
        }
      }
    } catch (error) {
      console.info(`${TAG} React reload unavailable:`, error);
    }

    // Fallback: does not request a new token, but unsticks a frozen picture.
    const video = document.querySelector("video");
    if (video) {
      try {
        video.currentTime = video.currentTime; // eslint-disable-line no-self-assign
        const playing = video.play();
        if (playing && typeof playing.catch === "function") playing.catch(() => {});
        return "video:seek";
      } catch {
        /* nothing more to try */
      }
    }
    return "none";
  }

  // -- 4. hiding an ad that cannot be replaced ----------------------------

  /**
   * Last resort when no clean feed exists.
   *
   * Under SSAI the live content is not broadcast during the break, so it cannot
   * be restored. The ad can, however, be neither seen nor heard: cover the
   * player and mute it until the break ends. That is what makes behaviour
   * uniform across channels, including those where nothing is replaceable.
   */
  const OVERLAY_ID = "twitch-ads-remove-overlay";
  const OVERLAY_MAX_S = 120;
  let overlayUntil = 0;
  let overlayTimer = null;
  let mutedBefore = null;

  function playerContainer() {
    return (
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector(".video-player") ||
      (document.querySelector("video") || {}).parentElement ||
      null
    );
  }

  function hidePlayer(durationSeconds) {
    const container = playerContainer();
    if (!container) return;

    // A player reload rebuilds the DOM, orphaning an overlay placed earlier, so
    // it is re-created on every event rather than assumed to still be there.
    const duration = Math.min(Math.max(Number(durationSeconds) || 30, 5), OVERLAY_MAX_S);
    overlayUntil = Date.now() / 1000 + duration + 5;

    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("style", [
        "position:absolute",
        "inset:0",
        "z-index:9",
        "background:#0e0e10",
        "color:#efeff1",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:6px",
        "font:500 15px/1.4 Inter,-apple-system,'Segoe UI',Roboto,sans-serif",
        "pointer-events:none",
      ].join(";"));

      const title = document.createElement("div");
      title.textContent = "Ad hidden";
      const countdown = document.createElement("div");
      countdown.id = `${OVERLAY_ID}-countdown`;
      countdown.setAttribute("style", "color:#adadb8;font-size:12.5px");
      overlay.append(title, countdown);

      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      container.appendChild(overlay);
    }

    const video = document.querySelector("video");
    if (video && mutedBefore === null) {
      mutedBefore = video.muted;
      video.muted = true;
    }

    if (overlayTimer) clearInterval(overlayTimer);
    overlayTimer = setInterval(() => {
      const left = Math.ceil(overlayUntil - Date.now() / 1000);
      const line = document.getElementById(`${OVERLAY_ID}-countdown`);
      if (line) line.textContent = left > 0 ? `live returns in ${left}s` : "resuming…";
      // Safety net: an overlay stuck on screen would be far worse than the ad.
      if (left <= 0) revealPlayer();
    }, 500);
  }

  function revealPlayer() {
    if (overlayTimer) {
      clearInterval(overlayTimer);
      overlayTimer = null;
    }
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    const video = document.querySelector("video");
    if (video && mutedBefore !== null) video.muted = mutedBefore;
    mutedBefore = null;
  }

  // -- 5. watching the picture ---------------------------------------------

  /**
   * Watch the element the user actually looks at.
   *
   * Every measurement so far lived in the worker, and the worker is exactly
   * what the player tears down when it gives up — so a freeze erased its own
   * evidence. This lives in the page, which survives that, and it listens to
   * the media events the browser fires when a picture starves: `waiting` and
   * `stalled`. Those are not timers, so a throttled background tab does not
   * delay them.
   *
   * It also acts. A stream stuck for this long needs a reload either way; the
   * user was doing it by hand.
   *
   * The decision is taken in the event handlers, not only on a tick. The tick
   * is a `setInterval`, which Chrome throttles to once a minute in a page that
   * has been hidden for a while — precisely the case this exists for. Media
   * events carry no such penalty, so every one of them is a chance to act.
   */
  const STALL_SECONDS = 12;
  const STALL_RELOAD_COOLDOWN = 45;

  let stalledSince = 0;
  let lastStallReload = 0;
  let stallAnnounced = false;

  function currentVideo() {
    return document.querySelector("video");
  }

  function pictureMoving() {
    const video = currentVideo();
    return Boolean(video) && !video.paused && video.readyState >= 3;
  }

  function onStarved(what) {
    if (!stalledSince) {
      stalledSince = Date.now() / 1000;
      stallAnnounced = false;
      console.info(`${TAG} picture starved (${what}, tab ${document.visibilityState})`);
    }
    // A second `waiting` while already starved is the only heartbeat available
    // in a throttled tab: take the opportunity to decide.
    checkStall();
  }

  function onFlowing() {
    if (!stalledSince) return;
    const held = Math.round((Date.now() / 1000 - stalledSince) * 10) / 10;
    stalledSince = 0;
    stallAnnounced = false;
    if (held >= 2) {
      console.info(`${TAG} picture recovered after ${held}s`);
      toExtension("event", { event: { type: "pictureRecovered", seconds: held } });
    }
  }

  /**
   * Media events do not bubble, but they do capture — one listener on the
   * document catches them from whatever `<video>` the player has built, and
   * there is no element to re-attach to when it builds a new one.
   */
  function watchPicture() {
    for (const name of ["waiting", "stalled"]) {
      document.addEventListener(name, () => onStarved(name), true);
    }
    for (const name of ["playing", "timeupdate"]) {
      document.addEventListener(name, () => onFlowing(), true);
    }

    // The player pausing itself is not the user pausing it, and it is what a
    // player does when it gives up on a timeline it cannot follow — which is
    // how a freeze escaped this watchdog entirely: `waiting` never fired.
    //
    // The two are told apart by the data on hand. A deliberate pause leaves a
    // full buffer; a player that has given up has nothing to play. Without
    // that guard, pausing a stream on purpose would have it reloaded from
    // under you twelve seconds later.
    for (const name of ["pause", "suspend", "emptied", "error"]) {
      document.addEventListener(
        name,
        () => {
          const video = currentVideo();
          if (video && video.readyState < 3) onStarved(name);
        },
        true,
      );
    }

    setInterval(tick, 2000);
    document.addEventListener("visibilitychange", tick);
  }

  /** Has the picture moved since we last looked? */
  function checkStall() {
    if (!enabled || !stalledSince) return;
    if (pictureMoving()) {
      onFlowing();
      return;
    }

    const stuck = Date.now() / 1000 - stalledSince;
    if (stuck < STALL_SECONDS) return;

    if (!stallAnnounced) {
      stallAnnounced = true;
      const hidden = document.visibilityState === "hidden";
      console.info(`${TAG} picture stuck for ${Math.round(stuck)}s (tab ${hidden ? "hidden" : "visible"})`);
      toExtension("event", {
        event: { type: "pictureStuck", seconds: Math.round(stuck), hidden },
      });
    }

    const t = Date.now() / 1000;
    if (t - lastStallReload < STALL_RELOAD_COOLDOWN) return;
    lastStallReload = t;
    const how = reloadPlayer();
    console.info(`${TAG} reloading the player to unstick it -> ${how}`);
    toExtension("event", { event: { type: "reloadPerformed", reason: "picture stuck", how } });
  }

  function tick() {
    if (!enabled) return;
    if (!stalledSince) {
      // Belt and braces: a picture can stop without any event firing at all.
      const video = currentVideo();
      if (video && video.readyState < 3 && video.currentTime > 0) onStarved("readyState");
      return;
    }
    checkStall();
  }

  // -- 6. the off switch --------------------------------------------------

  /**
   * Apply a switch change to a page that is already open.
   *
   * Switching off takes effect at once: the worker stops reading playlists and
   * any overlay is cleared. What cannot be undone live is the `Worker` subclass
   * — it was installed before the player existed, and removing it now would not
   * affect the worker already running. Switching back on therefore needs a
   * reload, which is what the popup says.
   */
  function applySwitch(next) {
    if (next === enabled) return;
    enabled = next;

    if (channel) channel.postMessage({ key: "ADS_Enabled", enabled });
    if (!enabled) revealPlayer();

    if (enabled && !hookInstalled) {
      console.info(`${TAG} switched on — reload the page to hook the player`);
      return;
    }
    console.info(`${TAG} switched ${enabled ? "on" : "off"}`);
  }

  /**
   * Pass the learned order of backup sources down to the worker.
   *
   * It arrives with every telemetry round trip, so it is compared before being
   * forwarded: the order changes a few times an hour at most, and there is no
   * reason to wake the worker twice a second for an identical list.
   */
  let announcedOrder = "";
  function applyRanking(list) {
    const order = Array.isArray(list) ? list.filter((l) => typeof l === "string") : [];
    const signature = order.join("|");
    if (!channel || signature === announcedOrder) return;
    announcedOrder = signature;
    channel.postMessage({ key: "ADS_Ranking", order });
  }

  // -- commands from the extension ----------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "ads-remove-extension") return;
    if (data.type === "reload") reloadPlayer();
    else if (data.type === "setEnabled") applySwitch(data.enabled !== false);
    else if (data.type === "ranking") applyRanking(data.order);
  });

  // The channel stays open even when off, so the switch can be flipped back
  // without reloading, and so a worker that survives the change hears about it.
  openChannel();
  watchAddress();
  watchVisibility();
  watchPicture();

  if (!enabled) {
    console.info(`${TAG} switched off — the player is left untouched`);
    return;
  }

  hookWorker();
  broadcastVisibility(true);
  broadcastChannelName();
  console.info(`${TAG} hook installed`);
})();
