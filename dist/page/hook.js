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

  const WORKER_PAYLOAD = "(() => {\n\"use strict\";\n/* src/lib/hls.js */\n/**\n * HLS playlist parsing and ad-segment detection.\n *\n * Pure module: no I/O, no browser API. It runs in Node (tests) and in a worker.\n * Everything Twitch is likely to change one day lives here, so it can be checked\n * offline against real captured playlists.\n */\n\n/**\n * Generic ad marker. Twitch tags breaks with `CLASS=\"twitch-stitched-ad\"` and\n * `stitched-ad-<n>` ids; matching the substring survives tag renames.\n */\nconst AD_SIGNIFIER = \"stitched\";\n\n/** Title carried by content segments: `#EXTINF:2.000,live`. */\nconst LIVE_TITLE = \"live\";\n\n/** Neutral URL substituted for ad tracking URLs. */\nconst NEUTRAL_URL = \"https://twitch.tv\";\n\nconst ATTR_RE = /([A-Za-z0-9-]+)=(\"[^\"]*\"|[^,]*)/g;\nconst EXTINF_RE = /^#EXTINF:\\s*([0-9.]+)\\s*,?(.*)$/;\nconst SEQ_RE = /^#EXT-X-MEDIA-SEQUENCE:[ \\t]*([0-9]+)[ \\t]*$/m;\n\nconst TRACKING_ATTRS = [\n  \"X-TV-TWITCH-AD-URL\",\n  \"X-TV-TWITCH-AD-CLICK-TRACKING-URL\",\n  \"X-TV-TWITCH-TRIGGER-URL\",\n];\n\n/**\n * Split an HLS attribute list into an object.\n * Handles commas inside quoted values, common in ad tracking URLs.\n */\nfunction parseAttributes(value) {\n  const out = {};\n  if (!value) return out;\n  // `matchAll` rather than repeated `exec`: no shared `lastIndex` to reset.\n  for (const match of value.matchAll(ATTR_RE)) {\n    let raw = (match[2] || \"\").trim();\n    if (raw.length >= 2 && raw.startsWith('\"') && raw.endsWith('\"')) {\n      raw = raw.slice(1, -1);\n    }\n    out[match[1]] = raw;\n  }\n  return out;\n}\n\nfunction lines(text) {\n  return String(text).replace(/\\r/g, \"\").split(\"\\n\");\n}\n\n/** First non-empty, non-comment line after `start`. */\nfunction nextUrl(all, start) {\n  for (const candidate of all.slice(start, start + 3)) {\n    const stripped = candidate.trim();\n    if (stripped && !stripped.startsWith(\"#\")) return stripped;\n  }\n  return \"\";\n}\n\nfunction toFloat(value) {\n  const n = Number.parseFloat(value);\n  return Number.isFinite(n) ? n : 0;\n}\n\nfunction toInt(value) {\n  const n = Number.parseInt(value, 10);\n  return Number.isFinite(n) ? n : 0;\n}\n\n/** True when the playlist is a master (list of renditions). */\nfunction isMaster(text) {\n  return String(text).includes(\"#EXT-X-STREAM-INF\");\n}\n\n/**\n * Cheapest possible test for ads in a playlist. This runs on every playlist\n * response — every ~2s, per rendition — hence the plain substring search.\n */\nfunction hasAdMarkers(text) {\n  return String(text).includes(AD_SIGNIFIER);\n}\n\n/** HEVC renditions break a hot stream swap: the decoder cannot change codec. */\nfunction isHevc(codecs) {\n  const c = codecs || \"\";\n  return c.startsWith(\"hev\") || c.startsWith(\"hvc\");\n}\n\n/** A segment is an ad as soon as its title is not exactly `live`. */\nfunction isAdSegment(segment) {\n  return (segment.title || \"\").trim().toLowerCase() !== LIVE_TITLE;\n}\n\n/** Extract the renditions declared by a master playlist. */\nfunction parseVariants(text) {\n  const all = lines(text);\n  const variants = [];\n\n  for (let i = 0; i < all.length; i += 1) {\n    const line = all[i];\n    if (!line.startsWith(\"#EXT-X-STREAM-INF\")) continue;\n    const url = nextUrl(all, i + 1);\n    if (!url) continue;\n    const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n    variants.push({\n      url,\n      bandwidth: toInt(attrs.BANDWIDTH),\n      resolution: attrs.RESOLUTION || \"\",\n      codecs: attrs.CODECS || \"\",\n      groupId: attrs.VIDEO || \"\",\n      name: \"\",\n      // Plain field, not a getter: a variant crosses `postMessage`, which\n      // cannot serialise accessors.\n      isHevc: isHevc(attrs.CODECS),\n    });\n  }\n\n  // Human-readable names (\"1080p60\") live in #EXT-X-MEDIA, paired by GROUP-ID.\n  const names = {};\n  for (const line of all) {\n    if (!line.startsWith(\"#EXT-X-MEDIA\")) continue;\n    const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n    if (attrs[\"GROUP-ID\"]) names[attrs[\"GROUP-ID\"]] = attrs.NAME || \"\";\n  }\n  for (const variant of variants) variant.name = names[variant.groupId] || \"\";\n\n  return variants;\n}\n\n/** Display label for a rendition. */\nfunction qualityLabel(variant) {\n  if (!variant) return \"?\";\n  return variant.name || variant.resolution || \"?\";\n}\n\n/** Parse a media playlist and classify every segment as ad or content. */\nfunction parseMedia(text) {\n  const playlist = {\n    segments: [],\n    adBreaks: [],\n    prefetch: [],\n    mediaSequence: 0,\n    hasAdMarkers: hasAdMarkers(text),\n  };\n  const all = lines(text);\n  let pendingDiscontinuity = false;\n\n  for (let i = 0; i < all.length; i += 1) {\n    const line = all[i];\n\n    if (line.startsWith(\"#EXT-X-MEDIA-SEQUENCE:\")) {\n      playlist.mediaSequence = toInt(line.split(\":\").slice(1).join(\":\").trim());\n    } else if (line.startsWith(\"#EXT-X-DISCONTINUITY\")) {\n      pendingDiscontinuity = true;\n    } else if (line.startsWith(\"#EXT-X-DATERANGE:\")) {\n      const attrs = parseAttributes(line.split(\":\").slice(1).join(\":\"));\n      const klass = attrs.CLASS || \"\";\n      const id = attrs.ID || \"\";\n      // A real break carries seven DATERANGE tags; only one describes the ad.\n      if (!klass.includes(AD_SIGNIFIER) && !id.includes(AD_SIGNIFIER)) continue;\n      playlist.adBreaks.push({\n        id,\n        duration: toFloat(attrs.DURATION),\n        rollType: attrs[\"X-TV-TWITCH-AD-ROLL-TYPE\"] || \"\",\n        podLength: toInt(attrs[\"X-TV-TWITCH-AD-POD-LENGTH\"]),\n        attributes: attrs,\n      });\n    } else if (line.startsWith(\"#EXT-X-TWITCH-PREFETCH:\")) {\n      playlist.prefetch.push(line.split(\":\").slice(1).join(\":\").trim());\n    } else if (line.startsWith(\"#EXTINF:\")) {\n      const match = EXTINF_RE.exec(line);\n      if (!match) continue;\n      const url = nextUrl(all, i + 1);\n      if (!url) continue;\n      playlist.segments.push({\n        url,\n        duration: toFloat(match[1]),\n        title: match[2],\n        discontinuity: pendingDiscontinuity,\n      });\n      pendingDiscontinuity = false;\n    }\n  }\n\n  return playlist;\n}\n\nfunction adSegments(playlist) {\n  return playlist.segments.filter(isAdSegment);\n}\n\nfunction liveSegments(playlist) {\n  return playlist.segments.filter((s) => !isAdSegment(s));\n}\n\n/**\n * Is an ad break running?\n *\n * The marker alone is not enough: the break's `#EXT-X-DATERANGE` stays in the\n * sliding window long after the ad segments are gone. Trusting it kept a break\n * \"running\" for another minute, inflating the ad time reported and showing a\n * 20s preroll as lasting 44s.\n *\n * The rule that holds: there is a break if ad segments remain, or if the marker\n * is present and no live segment is being served.\n */\nfunction isAdBreak(playlist) {\n  if (adSegments(playlist).length > 0) return true;\n  return playlist.hasAdMarkers && liveSegments(playlist).length === 0;\n}\n\nfunction rollType(playlist) {\n  for (const brk of playlist.adBreaks) if (brk.rollType) return brk.rollType;\n  return \"\";\n}\n\nfunction neutraliseTracking(line) {\n  let out = line;\n  for (const attr of TRACKING_ATTRS) {\n    out = out.replace(new RegExp(`(${attr}=\")[^\"]*(\")`, \"g\"), `$1${NEUTRAL_URL}$2`);\n  }\n  return out;\n}\n\n/**\n * Remove ad segments from a media playlist.\n *\n * Fallback used when no clean stream could be obtained. It does **not** restore\n * the live content: under SSAI the content is not broadcast during the break.\n *\n * Returns `{ text, removed }`.\n */\nfunction stripAds(text) {\n  const all = lines(text);\n  const out = [];\n  let removed = 0;\n  /**\n   * Ad segments dropped *before* the first one kept.\n   *\n   * `#EXT-X-MEDIA-SEQUENCE` numbers the first segment of the playlist, and the\n   * rest follow by position. Dropping segments from the head therefore renames\n   * every segment after them unless the sequence is raised to match — the\n   * player would receive the same segment under a new number on each poll,\n   * re-download it, and never see the timeline advance.\n   */\n  let removedBefore = 0;\n  let kept = 0;\n  let skipNextUrl = false;\n  const duringBreak = hasAdMarkers(text);\n\n  for (let line of all) {\n    if (skipNextUrl && line.trim() && !line.startsWith(\"#\")) {\n      skipNextUrl = false;\n      continue;\n    }\n    skipNextUrl = false;\n\n    if (line.startsWith(\"#EXTINF:\")) {\n      const match = EXTINF_RE.exec(line);\n      if (match && match[2].trim().toLowerCase() !== LIVE_TITLE) {\n        removed += 1;\n        if (kept === 0) removedBefore += 1;\n        skipNextUrl = true;\n        continue;\n      }\n      kept += 1;\n    }\n\n    // A prefetched segment cannot be classified, so low-latency prefetch is\n    // disabled for the duration of the break — otherwise the player shows the\n    // ad through it anyway.\n    if (line.startsWith(\"#EXT-X-TWITCH-PREFETCH:\") && duringBreak) continue;\n\n    if (line.startsWith(\"#EXT-X-DATERANGE:\")) line = neutraliseTracking(line);\n\n    out.push(line);\n  }\n\n  let cleaned = out.join(\"\\n\");\n  if (removedBefore > 0 && kept > 0) {\n    cleaned = writeMediaSequence(cleaned, readMediaSequence(cleaned) + removedBefore);\n  }\n  return { text: cleaned, removed, removedBefore };\n}\n\n/** Media sequence number announced by the playlist (0 if absent). */\nfunction readMediaSequence(text) {\n  const found = SEQ_RE.exec(String(text));\n  return found ? Number(found[1]) : 0;\n}\n\n/**\n * Rewrite `#EXT-X-MEDIA-SEQUENCE`.\n *\n * Required when switching source: every Twitch session has its own numbering\n * (a preroll even restarts at 0), and a live playlist whose sequence number\n * goes **backwards** is stale to a player — it waits instead of playing, which\n * looks like a load that never finishes.\n */\nfunction writeMediaSequence(text, value) {\n  const n = Math.max(0, Math.floor(value));\n  const source = String(text);\n  if (SEQ_RE.test(source)) {\n    return source.replace(SEQ_RE, `#EXT-X-MEDIA-SEQUENCE:${n}`);\n  }\n  const all = lines(source);\n  const header = all.findIndex((l) => l.startsWith(\"#EXTM3U\"));\n  const at = header === -1 ? 0 : header + 1;\n  return [...all.slice(0, at), `#EXT-X-MEDIA-SEQUENCE:${n}`, ...all.slice(at)].join(\"\\n\");\n}\n\n/** Number of segments announced, without parsing the whole playlist. */\nfunction countSegments(text) {\n  return (String(text).match(/^#EXTINF:/gm) || []).length;\n}\n\n/**\n * Insert `#EXT-X-DISCONTINUITY` before the first segment.\n *\n * Required on every source switch. Segments then come from another playback\n * session whose timestamps are rewritten independently; without the tag audio\n * resynchronises but the picture freezes.\n */\nfunction markDiscontinuity(text) {\n  const all = lines(text);\n  for (let i = 0; i < all.length; i += 1) {\n    if (!all[i].startsWith(\"#EXTINF:\")) continue;\n    if (i > 0 && all[i - 1].startsWith(\"#EXT-X-DISCONTINUITY\")) return text;\n    return [...all.slice(0, i), \"#EXT-X-DISCONTINUITY\", ...all.slice(i)].join(\"\\n\");\n  }\n  return text;\n}\n\n/**\n * Remove HEVC renditions from a master playlist.\n *\n * Twitch encodes 1440p/4K in HEVC but offers no HEVC replacement feed. If the\n * player settles on an HEVC rendition, any substitution feeds AVC into a\n * decoder initialised for HEVC — Chromium reports \"error 3000\".\n *\n * Returns `{ text, removed }`.\n */\nfunction stripHevcVariants(text) {\n  const all = lines(text);\n  const droppedGroups = new Set();\n  const kept = [];\n  let removed = 0;\n  let i = 0;\n\n  while (i < all.length) {\n    const line = all[i];\n    if (line.startsWith(\"#EXT-X-STREAM-INF\")) {\n      const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n      if (isHevc(attrs.CODECS)) {\n        droppedGroups.add(attrs.VIDEO || \"\");\n        removed += 1;\n        // Skip the URL that immediately follows.\n        i += 1;\n        while (i < all.length && (!all[i].trim() || all[i].startsWith(\"#\"))) i += 1;\n        i += 1;\n        continue;\n      }\n    }\n    kept.push(line);\n    i += 1;\n  }\n\n  if (!removed) return { text, removed: 0 };\n\n  // Orphaned #EXT-X-MEDIA tags must go with their rendition.\n  const out = [];\n  for (const line of kept) {\n    if (line.startsWith(\"#EXT-X-MEDIA\")) {\n      const attrs = parseAttributes(line.includes(\":\") ? line.split(\":\").slice(1).join(\":\") : \"\");\n      if (droppedGroups.has(attrs[\"GROUP-ID\"] || \"\")) continue;\n    }\n    out.push(line);\n  }\n  return { text: out.join(\"\\n\"), removed };\n}\n\n/* src/lib/stream.js */\n/**\r\n * Obtaining an ad-free Twitch stream.\r\n *\r\n * Under SSAI the live content is not broadcast during a break, so stripping ads\r\n * restores nothing. The only way to keep watching is to request *another feed of\r\n * the same stream*, issued for a different `playerType`, and hope it is not\r\n * stitched.\r\n *\r\n * The chain, per candidate:\r\n *\r\n *   1. `POST gql.twitch.tv/gql` — PlaybackAccessToken -> {value, signature}\r\n *   2. `GET usher.ttvnw.net/api/channel/hls/<channel>.m3u8?sig=…&token=…`\r\n *   3. `GET <rendition>` — if it carries no ad marker, the feed is clean.\r\n *\r\n * Pure module: all I/O goes through an injected\r\n * `fetcher(method, url, headers, body) -> Promise<{status, text}>`.\r\n */\r\n\r\n\r\n\r\nconst GQL_URL = \"https://gql.twitch.tv/gql\";\r\nconst USHER_URL = \"https://usher.ttvnw.net/api/channel/hls/{channel}.m3u8\";\r\n\r\n/** Public Client-ID of the Twitch web player. A public constant, not a secret. */\r\nconst CLIENT_ID = \"kimne78kx3ncx6brgo4mv6wki5h1ko\";\r\n\r\n/**\r\n * Persisted-query hash for `PlaybackAccessToken`.\r\n * Volatile: one of the first things Twitch will change.\r\n */\r\nconst PERSISTED_HASH =\r\n  \"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9\";\r\n\r\n/**\r\n * Backup candidates, in preference order. Measured against three live channels\r\n * with `tests/probe-candidates.mjs`:\r\n *\r\n * - `site/web` is the only pair that is consistently stitched — it is the\r\n *   player's own `playerType`, so a fresh token arrives with its ad. It is\r\n *   excluded.\r\n * - Nine pairs return source quality (up to 1080p60).\r\n * - `server_ads` and `hide_ads`, readable in the token, are identical for every\r\n *   pair: they describe the channel, not the session.\r\n *\r\n * Candidates are tried in parallel, so a longer list costs requests, not time.\r\n */\r\nconst BACKUP_CANDIDATES = [\r\n  { playerType: \"popout\", platform: \"web\" },\r\n  { playerType: \"mobile_web\", platform: \"web\" },\r\n  { playerType: \"embed\", platform: \"web\" },\r\n  { playerType: \"frontpage\", platform: \"web\" },\r\n  { playerType: \"channel_home_carousel\", platform: \"web\" },\r\n  { playerType: \"site\", platform: \"ios\" },\r\n  { playerType: \"site\", platform: \"android\" },\r\n  { playerType: \"embed\", platform: \"ios\" },\r\n  { playerType: \"mobile_web\", platform: \"ios\" },\r\n];\r\n\r\n/**\r\n * Last resort, at degraded quality (measured at 480p and 360p). Serving 480p to\r\n * a player that asked for source is a downgrade, but a milder one than a full\r\n * ad break — and these are only reached once the list above is exhausted.\r\n *\r\n * `autoplay` stays excluded despite its 360p: it leaves the player on an endless\r\n * loading spinner when the break ends.\r\n */\r\nconst LOW_QUALITY_CANDIDATES = [\r\n  { playerType: \"thunderdome\", platform: \"web\" },\r\n  { playerType: \"picture-by-picture\", platform: \"web\" },\r\n];\r\n\r\nfunction candidateLabel(candidate) {\r\n  return `${candidate.playerType}/${candidate.platform}`;\r\n}\r\n\r\n/**\r\n * Reorder candidates according to a learned order of labels.\r\n *\r\n * Advice, not a filter: a label missing from the order keeps its place at the\r\n * end rather than being dropped, so an order that has gone stale against a\r\n * newer candidate list can never make a candidate unreachable.\r\n */\r\nfunction orderCandidates(candidates, order) {\r\n  if (!Array.isArray(order) || !order.length) return candidates;\r\n  const rank = new Map(order.map((label, index) => [label, index]));\r\n  const place = (candidate) => {\r\n    const found = rank.get(candidateLabel(candidate));\r\n    return found === undefined ? Number.MAX_SAFE_INTEGER : found;\r\n  };\r\n  return candidates\r\n    .map((candidate, index) => ({ candidate, index }))\r\n    .sort((a, b) => place(a.candidate) - place(b.candidate) || a.index - b.index)\r\n    .map((entry) => entry.candidate);\r\n}\r\n\r\n/** Body of the GQL `PlaybackAccessToken` request. */\r\nfunction tokenPayload(channel, playerType, platform = \"web\") {\r\n  return {\r\n    operationName: \"PlaybackAccessToken\",\r\n    variables: {\r\n      isLive: true,\r\n      login: channel,\r\n      isVod: false,\r\n      vodID: \"\",\r\n      playerType,\r\n      platform,\r\n    },\r\n    extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } },\r\n  };\r\n}\r\n\r\n/** Master playlist URL for a given signature/token pair. */\r\nfunction usherUrl(channel, signature, token, random = Math.random) {\r\n  const params = new URLSearchParams({\r\n    sig: signature,\r\n    token,\r\n    allow_source: \"true\",\r\n    allow_audio_only: \"true\",\r\n    fast_bread: \"true\",\r\n    player_backend: \"mediaplayer\",\r\n    playlist_include_framerate: \"true\",\r\n    reassignments_supported: \"true\",\r\n    supported_codecs: \"avc1\", // HEVC breaks a hot swap\r\n    transcode_mode: \"cbr_v1\",\r\n    p: String(1_000_000 + Math.floor(random() * 9_000_000)),\r\n  });\r\n  return `${USHER_URL.replace(\"{channel}\", encodeURIComponent(channel))}?${params}`;\r\n}\r\n\r\n/**\r\n * Headers for backup requests: nothing beyond the public Client-ID.\r\n *\r\n * Two reasons, the second being the important one.\r\n *\r\n * 1. It works better. Measured on one channel, same instant, same preroll: with\r\n *    identity headers, 11 candidates out of 11 came back stitched; without them,\r\n *    a clean feed was found. Twitch ties the request to the same viewer and\r\n *    serves the same campaign everywhere — whereas a backup feed exists precisely\r\n *    to look like a *different* viewer.\r\n * 2. No secret is moved. Harvesting the page's OAuth token to pass it to the\r\n *    worker would mean broadcasting it on a same-origin channel.\r\n *\r\n * Accepted cost: channels that refuse an anonymous token get no backup feed.\r\n */\r\nfunction headers() {\r\n  return {\r\n    \"Client-ID\": CLIENT_ID,\r\n    \"Content-Type\": \"text/plain;charset=UTF-8\",\r\n  };\r\n}\r\n\r\n/** Extract `{value, signature}` from a GQL response, or null. */\r\nfunction readToken(text) {\r\n  let payload;\r\n  try {\r\n    payload = JSON.parse(text);\r\n  } catch {\r\n    return null;\r\n  }\r\n  const entries = Array.isArray(payload) ? payload : [payload];\r\n  for (const entry of entries) {\r\n    if (!entry || typeof entry !== \"object\") continue;\r\n    const data = entry.data || {};\r\n    const token = data.streamPlaybackAccessToken || data.videoPlaybackAccessToken;\r\n    if (token && token.value && token.signature) {\r\n      return { value: token.value, signature: token.signature };\r\n    }\r\n  }\r\n  return null;\r\n}\r\n\r\n/**\r\n * Pick the backup rendition closest to the one the player is reading.\r\n * HEVC is always excluded: changing codec family mid-stream breaks the decoder.\r\n */\r\nfunction pickVariant(variants, wanted) {\r\n  const usable = variants.filter((v) => !v.isHevc && !isHevc(v.codecs));\r\n  if (!usable.length) return null;\r\n  if (wanted) {\r\n    const exact = usable.filter((v) => v.resolution === wanted.resolution);\r\n    if (exact.length) return exact[0];\r\n    // Otherwise the best rendition below the requested one.\r\n    const lower = usable.filter((v) => v.bandwidth <= wanted.bandwidth);\r\n    if (lower.length) return lower.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));\r\n  }\r\n  return usable.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));\r\n}\r\n\r\nfunction cleanStream(channel, label, variant, media, master) {\r\n  return {\r\n    channel,\r\n    playerType: label,\r\n    mediaUrl: variant.url,\r\n    variant,\r\n    body: media,\r\n    master,\r\n    quality: qualityLabel(variant),\r\n  };\r\n}\r\n\r\n/** Full chain for one candidate. Never rejects. */\r\nasync function tryCandidate(candidate, channel, hdrs, fetcher, wanted) {\r\n  const label = candidateLabel(candidate);\r\n  try {\r\n    const gql = await fetcher(\r\n      \"POST\",\r\n      GQL_URL,\r\n      hdrs,\r\n      JSON.stringify(tokenPayload(channel, candidate.playerType, candidate.platform)),\r\n    );\r\n    if (gql.status !== 200) return { candidate, stream: null, reason: `gql HTTP ${gql.status}` };\r\n\r\n    const token = readToken(gql.text);\r\n    if (!token) return { candidate, stream: null, reason: \"gql returned no token\" };\r\n\r\n    const master = await fetcher(\"GET\", usherUrl(channel, token.signature, token.value), null, null);\r\n    if (master.status !== 200) {\r\n      return { candidate, stream: null, reason: `usher HTTP ${master.status}` };\r\n    }\r\n\r\n    const variant = pickVariant(parseVariants(master.text), wanted);\r\n    if (!variant) return { candidate, stream: null, reason: \"no usable rendition\" };\r\n\r\n    const media = await fetcher(\"GET\", variant.url, null, null);\r\n    if (media.status !== 200) {\r\n      return { candidate, stream: null, reason: `media HTTP ${media.status}` };\r\n    }\r\n    if (hasAdMarkers(media.text)) {\r\n      return { candidate, stream: null, reason: \"feed is stitched too\" };\r\n    }\r\n\r\n    return {\r\n      candidate,\r\n      stream: cleanStream(channel, label, variant, media.text, master.text),\r\n      reason: \"\",\r\n    };\r\n  } catch (error) {\r\n    return { candidate, stream: null, reason: String((error && error.message) || error) };\r\n  }\r\n}\r\n\r\n/**\r\n * Find an ad-free media playlist, trying every candidate in parallel.\r\n *\r\n * Sequentially each candidate costs ~0.65s, so the first clean feed arrived\r\n * about 2s into the break — two seconds during which the player only received a\r\n * stripped playlist. The result is still the *first clean candidate in list\r\n * order*, so parallelism does not degrade the choice.\r\n *\r\n * Never rejects: every failure is recorded in `attempts`, and the verdict of\r\n * every candidate — winner included, and those that would also have worked — in\r\n * `outcomes`, which is what the ranking learns from. `attempts` stops at the\r\n * winner on purpose: it exists to explain a failure, not to score.\r\n */\r\nasync function findCleanStream(\r\n  channel,\r\n  fetcher,\r\n  wanted = null,\r\n  candidates = BACKUP_CANDIDATES,\r\n) {\r\n  const result = { stream: null, attempts: [], outcomes: [] };\r\n  if (!candidates.length) return result;\r\n  const hdrs = headers();\r\n\r\n  const verdicts = await Promise.all(\r\n    candidates.map((c) => tryCandidate(c, channel, hdrs, fetcher, wanted)),\r\n  );\r\n\r\n  for (const verdict of verdicts) {\r\n    result.outcomes.push([candidateLabel(verdict.candidate), Boolean(verdict.stream)]);\r\n  }\r\n\r\n  for (const verdict of verdicts) {\r\n    if (verdict.stream) {\r\n      result.stream = verdict.stream;\r\n      return result;\r\n    }\r\n    result.attempts.push([candidateLabel(verdict.candidate), verdict.reason]);\r\n  }\r\n  return result;\r\n}\r\n\r\n/**\r\n * Derive a clean feed from a master playlist already obtained, for another\r\n * rendition of the same channel.\r\n *\r\n * The player polls several renditions at once; without this, each would replay\r\n * the whole chain for every candidate. The absence of ads is re-checked anyway,\r\n * since the ad server can catch one rendition and not another.\r\n */\r\nasync function cleanStreamFromMaster(channel, label, master, fetcher, wanted = null) {\r\n  const variant = pickVariant(parseVariants(master), wanted);\r\n  if (!variant) return null;\r\n  let media;\r\n  try {\r\n    media = await fetcher(\"GET\", variant.url, null, null);\r\n  } catch {\r\n    return null;\r\n  }\r\n  if (media.status !== 200 || hasAdMarkers(media.text)) return null;\r\n  return cleanStream(channel, label, variant, media.text, master);\r\n}\n\n/* src/lib/blocker.js */\n/**\r\n * Decision engine: what to serve the player for every media playlist it asks for.\r\n *\r\n * Three outcomes, in order of preference:\r\n *\r\n *   1. serve an ad-free feed obtained for a different `playerType` (a swap);\r\n *   2. strip the ad segments, when live content remains in the playlist;\r\n *   3. serve the original playlist untouched, when stripping would empty it —\r\n *      an empty live playlist sends the player to the streamer's offline screen.\r\n *\r\n * Case 3 is where a browser extension can do what a proxy cannot: ask the player\r\n * to start a new playback session, giving Twitch another chance to hand out an\r\n * unstitched stream. That reload is instrumented (`reloads`, `usefulReloads`) so\r\n * its value is measured rather than assumed.\r\n *\r\n * Pure module: no network, no DOM. Everything goes through injected functions.\r\n */\r\n\r\n\r\n\r\n\r\n/** How long a backup feed stays valid, in seconds. */\r\nconst BACKUP_TTL = 240;\r\n\r\n/**\r\n * Back-off after a failed search, doubling on each consecutive failure.\r\n *\r\n * One search costs up to eleven candidates times three requests. Repeated every\r\n * five seconds through a long unblockable break, that was in the order of 400\r\n * requests per minute for an outcome already known.\r\n */\r\nconst BACKOFF_BASE = 5;\r\nconst BACKOFF_MAX = 60;\r\n\r\nfunction backoffAfter(failures) {\r\n  return Math.min(BACKOFF_BASE * 2 ** Math.max(0, failures - 1), BACKOFF_MAX);\r\n}\r\n\r\n/** Very short cache of a backup body: the player polls faster than Twitch updates. */\r\nconst BACKUP_BODY_TTL = 1.5;\r\n/** Reuse of an already-obtained master for the channel's other renditions. */\r\nconst MASTER_TTL = 12;\r\n/** Past this, warn that the player is sitting on a loading screen. */\r\nconst STRIP_WARN = 12;\r\n/** How long the player's request is held while the first search runs. */\r\nconst FIRST_WAIT = 2.5;\r\n/** A playlist URL not seen for this long is considered abandoned. */\r\nconst URL_STALE = 12;\r\n/** Upper bound on per-URL state, for multi-hour sessions. */\r\nconst MAX_URLS = 64;\r\n/** Past this, a memorised backup body has no chance of being useful. */\r\nconst BODY_STALE = 30;\r\n\r\n/** Never two reloads back to back: that would be an unbearable loop. */\r\nconst RELOAD_COOLDOWN = 25;\r\n/** And never more than two attempts for the same break. */\r\nconst RELOAD_MAX_PER_BREAK = 2;\r\n\r\nconst DEFAULT_OPTIONS = {\r\n  block: true,\r\n  swap: true,\r\n  dropHevc: true,\r\n  reloadPlayer: true,\r\n  // On by default: the degraded list is only consulted after the nine\r\n  // source-quality candidates, and 480p beats a full ad break.\r\n  lowQuality: true,\r\n};\r\n\r\n/**\r\n * Await a promise, but for at most `seconds`. The timer is cancelled as soon as\r\n * the promise settles, so no 2.5s timer is left pending on every break.\r\n */\r\nfunction raceWithDeadline(promise, seconds) {\r\n  return new Promise((resolve) => {\r\n    const timer = setTimeout(resolve, seconds * 1000);\r\n    const done = () => {\r\n      clearTimeout(timer);\r\n      resolve();\r\n    };\r\n    promise.then(done, done);\r\n  });\r\n}\r\n\r\nfunction createBlocker({\r\n  fetcher,\r\n  now = () => Date.now() / 1000,\r\n  onReload = () => false,\r\n  onEvent = () => {},\r\n  options = {},\r\n} = {}) {\r\n  const opt = { ...DEFAULT_OPTIONS, ...options };\r\n\r\n  /**\r\n   * All state for one playlist URL, in a single record.\r\n   *\r\n   * This used to be thirteen parallel maps on the same key. Each had to be\r\n   * remembered when pruning and when a break ended, and two had already been\r\n   * missed — state outliving what it described. One map makes that impossible.\r\n   */\r\n  const states = new Map();\r\n  /** Backup bodies, keyed by *backup* URL rather than playlist URL. */\r\n  const backupBodies = new Map();\r\n  /** In-flight searches; self-cleaning, so never any residue to prune. */\r\n  const searches = new Map();\r\n\r\n  function stateOf(url) {\r\n    let state = states.get(url);\r\n    if (!state) {\r\n      state = {\r\n        seenAt: 0,\r\n        inBreak: false,\r\n        variant: null, // {channel, variant}\r\n        backup: null, // {url, label, obtainedAt, quality}\r\n        serving: \"origin\",\r\n        failedTypes: null, // Map(label -> timestamp)\r\n        blockedUntil: 0,\r\n        failures: 0,\r\n        strippingSince: 0,\r\n        stripWarned: false,\r\n        letThroughWarned: false,\r\n        counted: null, // {channel, letThrough}\r\n        sequenceOffset: 0,\r\n        lastSequence: -1,\r\n      };\r\n      states.set(url, state);\r\n    }\r\n    return state;\r\n  }\r\n\r\n  /** Reset what only makes sense during a break. */\r\n  function endOfBreak(state) {\r\n    state.backup = null;\r\n    state.failedTypes = null;\r\n    state.strippingSince = 0;\r\n    state.stripWarned = false;\r\n    state.letThroughWarned = false;\r\n    state.counted = null;\r\n    state.blockedUntil = 0;\r\n    // New break, new chance: start again from a short back-off.\r\n    state.failures = 0;\r\n  }\r\n\r\n  // -- session-wide state -------------------------------------------------\r\n  let currentChannel = \"\";\r\n  let cleanMaster = null; // {channel, label, master, obtainedAt}\r\n  const tally = new Map(); // channel -> [blocked, letThrough]\r\n\r\n  const counters = {\r\n    breaks: 0,\r\n    swaps: 0,\r\n    strippedSegments: 0,\r\n    adsLetThrough: 0,\r\n    failedSearches: 0,\r\n    reloads: 0,\r\n    usefulReloads: 0,\r\n    lastSearchMs: 0,\r\n  };\r\n  let lastBreak = null;\r\n  let adTimeTotal = 0;\r\n  let lastTick = null;\r\n  const sessionStart = now();\r\n\r\n  let lastReload = -Infinity;\r\n  let reloadsThisBreak = 0;\r\n  /** True while waiting to see whether a reload achieved anything. */\r\n  let watchingReload = false;\r\n\r\n  function log(level, message) {\r\n    onEvent({ type: \"log\", level, message });\r\n  }\r\n\r\n  /**\r\n   * Learned order of the backup sources, supplied by the service worker.\r\n   *\r\n   * It is advice, not a filter: nothing is ever removed from the list, only\r\n   * moved. A candidate the ranking has never heard of stays where the\r\n   * hand-picked list put it.\r\n   */\r\n  let order = [];\r\n\r\n  function setRanking(labels) {\r\n    const next = Array.isArray(labels) ? labels.filter((l) => typeof l === \"string\") : [];\r\n    if (next.join(\"|\") === order.join(\"|\")) return false;\r\n    order = next;\r\n    return true;\r\n  }\r\n\r\n  function candidates() {\r\n    const list = opt.lowQuality\r\n      ? [...BACKUP_CANDIDATES, ...LOW_QUALITY_CANDIDATES]\r\n      : BACKUP_CANDIDATES;\r\n    return orderCandidates(list, order);\r\n  }\r\n\r\n  /** Candidates still worth trying for this URL during the current break. */\r\n  function remainingCandidates(url) {\r\n    const failed = stateOf(url).failedTypes;\r\n    if (!failed || !failed.size) return candidates();\r\n    const left = candidates().filter((c) => !failed.has(candidateLabel(c)));\r\n    // All burned: give them another chance rather than trying nothing.\r\n    return left.length ? left : candidates();\r\n  }\r\n\r\n  /**\r\n   * Bound the per-URL state. A multi-hour session goes through many playlist\r\n   * URLs: quality changes, channel changes, CDN rotations.\r\n   */\r\n  function prune() {\r\n    // Backup bodies are keyed by backup URL, so they cannot follow a playlist's\r\n    // fate and are bounded by age instead.\r\n    const t = now();\r\n    for (const [key, body] of backupBodies) {\r\n      if (t - body.at > BODY_STALE) backupBodies.delete(key);\r\n    }\r\n\r\n    if (states.size <= MAX_URLS) return;\r\n    const sorted = [...states.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);\r\n    for (const [url] of sorted.slice(0, states.size - MAX_URLS)) states.delete(url);\r\n  }\r\n\r\n  /** URLs the player is still actively polling. */\r\n  function live() {\r\n    const t = now();\r\n    return [...states.entries()].filter(([, s]) => t - s.seenAt < URL_STALE).map(([url]) => url);\r\n  }\r\n\r\n  /**\r\n   * Keep the per-channel tally: one entry per break and per URL.\r\n   *\r\n   * A break can change verdict along the way — let through at first, then\r\n   * replaced once a clean feed is found. Counting both would make the table show\r\n   * more events than there were breaks, so the previous verdict is corrected.\r\n   */\r\n  function count(url, letThrough) {\r\n    const state = stateOf(url);\r\n    const channel = (state.variant && state.variant.channel) || currentChannel;\r\n    if (!channel) return;\r\n\r\n    const before = state.counted;\r\n    if (before && before.channel === channel && before.letThrough === letThrough) return;\r\n\r\n    if (before) {\r\n      const previous = tally.get(before.channel);\r\n      if (previous) {\r\n        const column = before.letThrough ? 1 : 0;\r\n        previous[column] = Math.max(0, previous[column] - 1);\r\n      }\r\n    }\r\n\r\n    const entry = tally.get(channel) || [0, 0];\r\n    entry[letThrough ? 1 : 0] += 1;\r\n    tally.set(channel, entry);\r\n    state.counted = { channel, letThrough };\r\n  }\r\n\r\n  /**\r\n   * Serve `body`, flagging any source change to the player.\r\n   *\r\n   * `source` identifies the precise feed, not its category: two successive\r\n   * backup feeds are two Twitch sessions, hence two timelines.\r\n   *\r\n   * It also keeps the media sequence strictly increasing. Every session has its\r\n   * own numbering — a preroll even restarts at 0 — and a live playlist whose\r\n   * sequence goes backwards is stale to a player: it waits instead of playing,\r\n   * which looks like a load that never finishes when the break ends.\r\n   */\r\n  function serve(url, body, source) {\r\n    let out = body;\r\n    const state = stateOf(url);\r\n    const sourceSequence = readMediaSequence(body);\r\n\r\n    if (state.serving !== source) {\r\n      out = markDiscontinuity(out);\r\n      state.serving = source;\r\n      state.sequenceOffset = state.lastSequence >= 0 ? state.lastSequence + 1 - sourceSequence : 0;\r\n      log(\"info\", `switched source -> ${source.startsWith(\"backup:\") ? \"replacement feed\" : \"original feed\"} (discontinuity flagged)`);\r\n    }\r\n\r\n    const served = sourceSequence + state.sequenceOffset;\r\n    if (state.sequenceOffset !== 0) out = writeMediaSequence(out, served);\r\n    state.lastSequence = Math.max(state.lastSequence, served + Math.max(0, countSegments(body) - 1));\r\n    return out;\r\n  }\r\n\r\n  /**\r\n   * Ask the player to start a new playback session.\r\n   *\r\n   * Tightly bounded: a reload is visible to the user (the picture restarts), so\r\n   * it must stay rare and only happen where the alternative is a full ad break.\r\n   */\r\n  function requestReload(reason) {\r\n    if (!opt.reloadPlayer) return false;\r\n    const t = now();\r\n    if (t - lastReload < RELOAD_COOLDOWN) return false;\r\n    if (reloadsThisBreak >= RELOAD_MAX_PER_BREAK) return false;\r\n    let accepted = false;\r\n    try {\r\n      accepted = onReload(reason) !== false;\r\n    } catch {\r\n      accepted = false;\r\n    }\r\n    if (!accepted) return false;\r\n    lastReload = t;\r\n    reloadsThisBreak += 1;\r\n    counters.reloads += 1;\r\n    watchingReload = true;\r\n    log(\"warning\", `player reload requested (${reason})`);\r\n    return true;\r\n  }\r\n\r\n  // -- master playlist ----------------------------------------------------\r\n\r\n  /**\r\n   * Record the renditions and drop HEVC ones.\r\n   *\r\n   * Recording happens *before* dropping: the player may already sit on an HEVC\r\n   * rendition from an earlier master, and we must recognise it to avoid\r\n   * attempting a substitution there.\r\n   */\r\n  function onMaster(url, text, channel) {\r\n    if (channel) currentChannel = channel;\r\n    const variants = parseVariants(text);\r\n    for (const variant of variants) {\r\n      stateOf(variant.url).variant = { channel: currentChannel, variant };\r\n    }\r\n    onEvent({ type: \"master\", channel: currentChannel, qualities: variants.map(qualityLabel) });\r\n    if (!opt.dropHevc) return text;\r\n    const { text: out, removed } = stripHevcVariants(text);\r\n    if (removed) {\r\n      log(\"info\", `dropped ${removed} HEVC rendition(s) — no HEVC replacement feed exists`);\r\n    }\r\n    return out;\r\n  }\r\n\r\n  // -- searching for a clean feed ----------------------------------------\r\n\r\n  async function search(url) {\r\n    const state = stateOf(url);\r\n    const channel = (state.variant && state.variant.channel) || currentChannel;\r\n    const wanted = state.variant ? state.variant.variant : null;\r\n    if (!channel) return null;\r\n\r\n    const started = now();\r\n\r\n    // A master already obtained covers the channel's other renditions: one\r\n    // request instead of the whole chain for every candidate.\r\n    if (cleanMaster && cleanMaster.channel === channel && started - cleanMaster.obtainedAt < MASTER_TTL) {\r\n      const feed = await cleanStreamFromMaster(channel, cleanMaster.label, cleanMaster.master, fetcher, wanted);\r\n      if (feed) {\r\n        state.backup = {\r\n          url: feed.mediaUrl,\r\n          label: feed.playerType,\r\n          obtainedAt: now(),\r\n          quality: feed.quality,\r\n        };\r\n        counters.lastSearchMs = Math.round((now() - started) * 1000);\r\n        return feed;\r\n      }\r\n      cleanMaster = null;\r\n    }\r\n\r\n    const result = await findCleanStream(channel, fetcher, wanted, remainingCandidates(url));\r\n    counters.lastSearchMs = Math.round((now() - started) * 1000);\r\n\r\n    if (!result.stream) {\r\n      counters.failedSearches += 1;\r\n      state.failures += 1;\r\n      const wait = backoffAfter(state.failures);\r\n      state.blockedUntil = now() + wait;\r\n      log(\"warning\", `no clean feed for ${channel} (retry in ${wait}s): ${result.attempts.map(([l, r]) => `${l} (${r})`).join(\", \")}`);\r\n      onEvent({\r\n        type: \"search\",\r\n        channel,\r\n        found: false,\r\n        attempts: result.attempts,\r\n        outcomes: result.outcomes,\r\n      });\r\n      return null;\r\n    }\r\n\r\n    const feed = result.stream;\r\n    state.failures = 0;\r\n    cleanMaster = { channel, label: feed.playerType, master: feed.master, obtainedAt: now() };\r\n    state.backup = {\r\n      url: feed.mediaUrl,\r\n      label: feed.playerType,\r\n      obtainedAt: now(),\r\n      quality: feed.quality,\r\n    };\r\n    log(\"info\", `clean feed found via ${feed.playerType} in ${counters.lastSearchMs}ms (${feed.quality})`);\r\n    onEvent({\r\n      type: \"search\",\r\n      channel,\r\n      found: true,\r\n      label: feed.playerType,\r\n      quality: feed.quality,\r\n      outcomes: result.outcomes,\r\n    });\r\n    return feed;\r\n  }\r\n\r\n  /** Deduplicate searches: the player polls several renditions at once. */\r\n  function startSearch(url) {\r\n    if (searches.has(url)) return searches.get(url);\r\n    if (now() < stateOf(url).blockedUntil) return null;\r\n    const promise = search(url)\r\n      .catch(() => null)\r\n      .finally(() => searches.delete(url));\r\n    searches.set(url, promise);\r\n    return promise;\r\n  }\r\n\r\n  /** Serve the memorised backup feed, or null if there is none (any more). */\r\n  async function serveBackup(url) {\r\n    const state = stateOf(url);\r\n    const entry = state.backup;\r\n    if (!entry) return null;\r\n    if (now() - entry.obtainedAt > BACKUP_TTL) {\r\n      state.backup = null;\r\n      return null;\r\n    }\r\n\r\n    let body;\r\n    const fresh = backupBodies.get(entry.url);\r\n    if (fresh && now() - fresh.at < BACKUP_BODY_TTL) {\r\n      body = fresh.body;\r\n    } else {\r\n      let response;\r\n      try {\r\n        response = await fetcher(\"GET\", entry.url, null, null);\r\n      } catch {\r\n        response = { status: 0, text: \"\" };\r\n      }\r\n      if (response.status !== 200 || !response.text.startsWith(\"#EXTM3U\")) {\r\n        state.backup = null;\r\n        backupBodies.delete(entry.url);\r\n        return null;\r\n      }\r\n      body = response.text;\r\n      backupBodies.set(entry.url, { at: now(), body });\r\n    }\r\n\r\n    if (hasAdMarkers(body)) {\r\n      // The backup feed was caught by the ad server. Drop it, and remember the\r\n      // playerType so it is not offered again during this break.\r\n      state.backup = null;\r\n      backupBodies.delete(entry.url);\r\n      if (!state.failedTypes) state.failedTypes = new Map();\r\n      state.failedTypes.set(entry.label, now());\r\n      log(\"info\", `replacement feed caught by ads (playerType=${entry.label})`);\r\n      return null;\r\n    }\r\n\r\n    state.strippingSince = 0;\r\n    state.stripWarned = false;\r\n    count(url, false);\r\n    counters.swaps += 1;\r\n    if (watchingReload) {\r\n      counters.usefulReloads += 1;\r\n      watchingReload = false;\r\n    }\r\n    onEvent({ type: \"swap\", label: entry.label, quality: entry.quality });\r\n    return serve(url, body, `backup:${entry.url}`);\r\n  }\r\n\r\n  // -- fallback: strip the ad segments ------------------------------------\r\n\r\n  function strip(url, text) {\r\n    const state = stateOf(url);\r\n    const { text: cleaned, removed } = stripAds(text);\r\n\r\n    // If stripping leaves NO segment — a preroll, or a fully advertised break —\r\n    // we do not serve an empty playlist: the player concludes the stream does\r\n    // not exist and switches to the streamer's offline screen, which needs a\r\n    // manual reload. Serving the ad is the lesser evil; the page hides it.\r\n    if (removed && parseMedia(cleaned).segments.length === 0) {\r\n      counters.adsLetThrough += 1;\r\n      count(url, true);\r\n      if (!state.letThroughWarned) {\r\n        state.letThroughWarned = true;\r\n        log(\"warning\", \"no clean feed and stripping would empty the playlist — letting the ad through to keep the player alive\");\r\n        onEvent({ type: \"adLetThrough\", duration: lastBreak ? lastBreak.duration : 0 });\r\n      }\r\n      requestReload(\"whole playlist is ads\");\r\n      return serve(url, text, \"origin\");\r\n    }\r\n\r\n    counters.strippedSegments += removed;\r\n\r\n    if (!state.strippingSince) state.strippingSince = now();\r\n    const elapsed = now() - state.strippingSince;\r\n    if (elapsed > STRIP_WARN && !state.stripWarned) {\r\n      state.stripWarned = true;\r\n      log(\"warning\", `no replacement feed for ${Math.round(elapsed)}s — the player is stuck loading`);\r\n      requestReload(\"player frozen with no replacement feed\");\r\n    }\r\n\r\n    return serve(url, cleaned, \"origin\");\r\n  }\r\n\r\n  // -- ad break -----------------------------------------------------------\r\n\r\n  async function handleBreak(url, text) {\r\n    if (!opt.swap) return strip(url, text);\r\n\r\n    const known = stateOf(url).variant;\r\n    if (known && known.variant.isHevc) {\r\n      // No backup feed exists in HEVC: substituting would break the decoder.\r\n      return strip(url, text);\r\n    }\r\n\r\n    const cached = await serveBackup(url);\r\n    if (cached !== null) return cached;\r\n\r\n    // First poll of the break, nothing cached. Rather than immediately serving a\r\n    // stripped playlist, give the search a short moment (~600ms in practice).\r\n    // The player has buffer and tolerates the wait better than a gap.\r\n    const running = startSearch(url);\r\n    if (running) {\r\n      await raceWithDeadline(running, FIRST_WAIT);\r\n      const found = await serveBackup(url);\r\n      if (found !== null) return found;\r\n    }\r\n\r\n    return strip(url, text);\r\n  }\r\n\r\n  // -- media playlist -----------------------------------------------------\r\n\r\n  async function onMedia(url, text) {\r\n    const state = stateOf(url);\r\n    state.seenAt = now();\r\n    const playlist = parseMedia(text);\r\n    const wasInBreak = state.inBreak;\r\n    const isInBreak = isAdBreak(playlist);\r\n\r\n    if (isInBreak && !wasInBreak) {\r\n      counters.breaks += 1;\r\n      reloadsThisBreak = 0;\r\n      const first = playlist.adBreaks[0];\r\n      lastBreak = {\r\n        at: now(),\r\n        // `roll`, never `type`: two names for the same thing once silently\r\n        // overwrote the event type.\r\n        roll: rollType(playlist) || \"?\",\r\n        duration: first ? first.duration : 0,\r\n        spots: first ? first.podLength : 0,\r\n      };\r\n      log(\"warning\", `>> AD #${counters.breaks} (${lastBreak.roll}, ${Math.round(lastBreak.duration)}s, pod=${lastBreak.spots})`);\r\n      onEvent({ type: \"break\", roll: lastBreak.roll, duration: lastBreak.duration, spots: lastBreak.spots });\r\n    } else if (wasInBreak && !isInBreak) {\r\n      log(\"info\", \"<< ad break over — back to live\");\r\n      endOfBreak(state);\r\n      // Live came back on its own; the reload, if any, may have nothing to do\r\n      // with it, so stop watching.\r\n      watchingReload = false;\r\n      onEvent({ type: \"breakOver\" });\r\n    }\r\n\r\n    // Cumulated ad time. Only URLs the player still polls are considered:\r\n    // otherwise one abandoned mid-break would stay flagged forever and keep the\r\n    // counter running.\r\n    const t = now();\r\n    if (lastTick !== null && live().some((u) => stateOf(u).inBreak)) {\r\n      adTimeTotal += t - lastTick;\r\n    }\r\n    lastTick = t;\r\n\r\n    state.inBreak = isInBreak;\r\n    prune();\r\n\r\n    if (isInBreak && opt.block) return handleBreak(url, text);\r\n    // Outside a break we still go through `serve`: it flags the return to the\r\n    // original feed and, above all, keeps the sequence numbering continuous.\r\n    if (opt.block) return serve(url, text, \"origin\");\r\n    return text;\r\n  }\r\n\r\n  /**\r\n   * Turn the engine off, or back on, without rebuilding it.\r\n   *\r\n   * Off is a genuine pass-through: every playlist is handed back exactly as it\r\n   * arrived. The switch exists so that a player misbehaving for any reason can\r\n   * be cleared of suspicion in one click, rather than by uninstalling.\r\n   */\r\n  function setEnabled(on) {\r\n    opt.block = on !== false;\r\n  }\r\n\r\n  /**\r\n   * Channel name supplied by the page.\r\n   *\r\n   * Without it everything depended on having seen the master go by, which the\r\n   * player does not always re-request (cached response, in-app navigation). We\r\n   * then knew about the break without being able to search for a backup feed.\r\n   */\r\n  function setChannel(channel) {\r\n    const clean = String(channel || \"\").trim().toLowerCase();\r\n    if (!clean || clean === currentChannel) return;\r\n    currentChannel = clean;\r\n    // Channel change: what we knew about the previous one no longer applies.\r\n    cleanMaster = null;\r\n  }\r\n\r\n  // -- telemetry ----------------------------------------------------------\r\n\r\n  function stats() {\r\n    const active = live();\r\n    const t = now();\r\n    const frozen = Math.max(\r\n      0,\r\n      ...active.map((url) => (stateOf(url).strippingSince ? t - stateOf(url).strippingSince : 0)),\r\n    );\r\n    const inBreak = active.filter((url) => stateOf(url).inBreak);\r\n\r\n    // The quality the player is asking for *right now*: the most recently seen\r\n    // URL. Walking insertion order picked an arbitrary active rendition.\r\n    let requested = \"\";\r\n    for (const url of [...active].sort((a, b) => stateOf(b).seenAt - stateOf(a).seenAt)) {\r\n      const known = stateOf(url).variant;\r\n      if (known) {\r\n        requested = qualityLabel(known.variant);\r\n        break;\r\n      }\r\n    }\r\n\r\n    const served = new Set();\r\n    const types = new Set();\r\n    for (const url of active) {\r\n      const entry = stateOf(url).backup;\r\n      if (!entry) continue;\r\n      served.add(entry.quality);\r\n      types.add(entry.label);\r\n    }\r\n\r\n    return {\r\n      frozenFor: frozen > STRIP_WARN ? Math.round(frozen * 10) / 10 : 0,\r\n      breaks: counters.breaks,\r\n      swaps: counters.swaps,\r\n      strippedSegments: counters.strippedSegments,\r\n      inBreak: inBreak.length > 0,\r\n      backupFeeds: [...types].sort(),\r\n      qualityServed: [...served].sort(),\r\n      watchedFor: Math.round(t - sessionStart),\r\n      adTimeAvoided: Math.round(adTimeTotal),\r\n      qualityRequested: requested,\r\n      failedSearches: counters.failedSearches,\r\n      channel: currentChannel,\r\n      lastBreak,\r\n      blocking: opt.block,\r\n      adsLetThrough: counters.adsLetThrough,\r\n      tally: Object.fromEntries([...tally.entries()].map(([c, v]) => [c, [...v]])),\r\n      adNotBlocked: inBreak.some((url) => stateOf(url).letThroughWarned),\r\n      reloads: counters.reloads,\r\n      usefulReloads: counters.usefulReloads,\r\n      // Current break, for the countdown: `startedAt` lets the display tick on\r\n      // its own between two reports instead of jumping every 2s.\r\n      currentBreak:\r\n        inBreak.length && lastBreak\r\n          ? {\r\n              roll: lastBreak.roll,\r\n              duration: lastBreak.duration,\r\n              spots: lastBreak.spots,\r\n              startedAt: lastBreak.at,\r\n            }\r\n          : null,\r\n      // Internal state size: the only way to check from outside that a long\r\n      // session stays bounded.\r\n      trackedUrls: states.size,\r\n      cachedBodies: backupBodies.size,\r\n    };\r\n  }\r\n\r\n  return { onMaster, onMedia, setChannel, setEnabled, setRanking, stats, options: opt };\r\n}\n\n/* src/worker/entry.js */\n/**\r\n * The part that runs *inside* the Twitch player's worker.\r\n *\r\n * The player does not fetch its playlists from the main thread: it uses the\r\n * `amazon-ivs-wasmworker` worker. Hooking `window.fetch` therefore sees nothing,\r\n * which is why `page/hook.js` rebuilds the worker blob with this code prepended.\r\n *\r\n * Two things learned from real traffic, both invisible offline:\r\n *\r\n * 1. Classifying by URL does not work. The master is served from\r\n *    `/api/v2/channel/hls/<channel>.m3u8`, and media playlists from\r\n *    `/v1/playlist/<blob>` — with no `.m3u8` extension. Filtering on `.m3u8`\r\n *    lets through exactly what needs intercepting, so classification is by\r\n *    content.\r\n * 2. Never post to the worker's own message channel. Sending it an unknown\r\n *    message freezes the player on an endless loading screen. All communication\r\n *    goes through a private `BroadcastChannel` whose name the page injects.\r\n */\r\n\r\n\r\n\r\n\r\n/** Master playlist: both `/api/channel/hls/` and `/api/v2/channel/hls/`. */\r\nconst MASTER_RE = /\\/channel\\/hls\\/([^./?]+)/;\r\n\r\n/** Worth reading: both playlist families, never segments. */\r\nconst PLAYLIST_RE = /\\/channel\\/hls\\/|\\/v1\\/playlist\\/|\\.m3u8/;\r\nconst SEGMENT_RE = /\\/v1\\/segment\\//;\r\n\r\nconst HLS_MIME = \"application/vnd.apple.mpegurl\";\r\n\r\n/** How often telemetry is broadcast. */\r\nconst TELEMETRY_MS = 2000;\r\n\r\nfunction urlOf(input) {\r\n  if (typeof input === \"string\") return input;\r\n  if (input && typeof input.url === \"string\") return input.url;\r\n  return \"\";\r\n}\r\n\r\n/** Channel name, taken from the master playlist path. */\r\nfunction channelFromUrl(url) {\r\n  const found = MASTER_RE.exec(url || \"\");\r\n  return found ? decodeURIComponent(found[1]).toLowerCase() : \"\";\r\n}\r\n\r\n/**\r\n * Is this response body worth reading?\r\n *\r\n * Deliberately broad: the *content* decides master versus media. Segments are\r\n * excluded explicitly — they are by far the most frequent requests, and reading\r\n * their bodies would cost a lot for nothing.\r\n */\r\nfunction isPlaylist(url) {\r\n  return PLAYLIST_RE.test(url) && !SEGMENT_RE.test(url);\r\n}\r\n\r\nfunction textResponse(text, origin) {\r\n  return new Response(text, {\r\n    status: 200,\r\n    statusText: \"OK\",\r\n    headers: { \"Content-Type\": HLS_MIME, \"X-Ads-Remove-Source\": origin },\r\n  });\r\n}\r\n\r\n/**\r\n * Install the hook in a worker scope.\r\n *\r\n * `scope` is `self` in production; tests pass a fake scope, which is what makes\r\n * this file verifiable without a browser.\r\n */\r\nfunction installHook(scope, options = {}) {\r\n  const originalFetch = scope.fetch.bind(scope);\r\n  const token = options.token || scope.__ADS_REMOVE_TOKEN || \"shared\";\r\n  // Identifier for THIS worker. The player creates several and recreates one on\r\n  // every reload; without distinct ids their reports overwrite each other and\r\n  // the counters restart from zero — exactly what aggregation exists to avoid.\r\n  const wid = options.wid || `w${Math.random().toString(36).slice(2, 8)}`;\r\n\r\n  // The off switch. False makes the hook a pass-through: no body is read, no\r\n  // telemetry is sent, and the player gets byte-for-byte what Twitch returned.\r\n  let enabled = options.enabled !== false;\r\n\r\n  // Private channel. Never `scope.postMessage`, which belongs to the player. The\r\n  // name carries a per-page token so another Twitch tab does not receive this\r\n  // tab's telemetry.\r\n  let channel = null;\r\n  try {\r\n    channel = new scope.BroadcastChannel(`twitch-ads-remove-${token}`);\r\n  } catch {\r\n    channel = null;\r\n  }\r\n\r\n  const send = (message) => {\r\n    if (!channel) return;\r\n    try {\r\n      channel.postMessage({ ...message, wid });\r\n    } catch {\r\n      /* channel closed: not important */\r\n    }\r\n  };\r\n\r\n  const trace = (url) => {\r\n    if (scope.__ADS_REMOVE_TRACE) {\r\n      send({ key: \"ADS_Event\", event: { type: \"traceFetch\", url: url.slice(0, 100) } });\r\n    }\r\n  };\r\n\r\n  /** Engine requests go through the original fetch, never through the hook. */\r\n  async function fetcher(method, url, headers, body) {\r\n    const response = await originalFetch(url, {\r\n      method,\r\n      headers: headers || undefined,\r\n      body: body || undefined,\r\n      // No cookies on backup calls: they must look like an anonymous session.\r\n      credentials: \"omit\",\r\n    });\r\n    return { status: response.status, text: await response.text() };\r\n  }\r\n\r\n  const blocker = createBlocker({\r\n    fetcher,\r\n    onReload: (reason) => {\r\n      send({ key: \"ADS_Reload\", reason });\r\n      return true;\r\n    },\r\n    onEvent: (event) => send({ key: \"ADS_Event\", event }),\r\n    options: options.options || {},\r\n  });\r\n\r\n  scope.fetch = async function hookedFetch(input, init) {\r\n    // First line, before anything is read or cloned: switched off must cost\r\n    // nothing and change nothing.\r\n    if (!enabled) return originalFetch(input, init);\r\n\r\n    const url = urlOf(input);\r\n    trace(url);\r\n\r\n    if (!isPlaylist(url)) return originalFetch(input, init);\r\n\r\n    const response = await originalFetch(input, init);\r\n    if (!response.ok) return response;\r\n\r\n    // Read the body from a clone: if anything fails afterwards, the original\r\n    // response is still consumable by the player.\r\n    let text;\r\n    try {\r\n      text = await response.clone().text();\r\n    } catch {\r\n      return response;\r\n    }\r\n    if (!text.startsWith(\"#EXTM3U\")) return response;\r\n\r\n    try {\r\n      if (isMaster(text)) {\r\n        const out = blocker.onMaster(url, text, channelFromUrl(url));\r\n        return out === text ? response : textResponse(out, \"master\");\r\n      }\r\n      const out = await blocker.onMedia(url, text);\r\n      return out === text ? response : textResponse(out, \"media\");\r\n    } catch (error) {\r\n      // An engine error must never break playback: hand back the original\r\n      // response, ads included.\r\n      send({ key: \"ADS_Event\", event: { type: \"error\", message: String(error && error.message) } });\r\n      return response;\r\n    }\r\n  };\r\n\r\n  // Three things are received from the page: the channel being watched, the off\r\n  // switch, and the learned order of the backup sources. No credentials travel:\r\n  // backup requests are anonymous by construction.\r\n  if (channel) {\r\n    channel.addEventListener(\"message\", (event) => {\r\n      const data = event && event.data;\r\n      if (data && data.key === \"ADS_Channel\") blocker.setChannel(data.channel);\r\n      else if (data && data.key === \"ADS_Enabled\") {\r\n        enabled = data.enabled !== false;\r\n        blocker.setEnabled(enabled);\r\n      } else if (data && data.key === \"ADS_Ranking\") blocker.setRanking(data.order);\r\n    });\r\n  }\r\n\r\n  const timer = setInterval(() => {\r\n    if (enabled) send({ key: \"ADS_Stats\", stats: blocker.stats() });\r\n  }, options.telemetryMs || TELEMETRY_MS);\r\n\r\n  send({ key: \"ADS_Ready\" });\r\n  return {\r\n    blocker,\r\n    stop: () => {\r\n      clearInterval(timer);\r\n      if (channel) channel.close();\r\n    },\r\n  };\r\n}\ntry { installHook(self, { enabled: globalThis.__ADS_REMOVE_ENABLED !== false }); } catch (e) { /* not a player worker */ }\n})();";
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

  // -- 5. the off switch --------------------------------------------------

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

  if (!enabled) {
    console.info(`${TAG} switched off — the player is left untouched`);
    return;
  }

  hookWorker();
  broadcastChannelName();
  console.info(`${TAG} hook installed`);
})();
