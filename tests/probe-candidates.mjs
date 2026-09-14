/**
 * Probe: which `playerType` currently returns an ad-free feed?
 *
 *     node tests/probe-candidates.mjs <channel> [more-channels...]
 *
 * The extension only tries a subset of the known `(playerType, platform)` pairs.
 * Which subset is worth trying is a measurement, not a guess, and it changes
 * over time — this script is how that measurement is taken.
 *
 * The GQL token also carries two fields worth reading before downloading any
 * playlist:
 *
 * - `server_ads` — the ad server inserts ads into THIS feed;
 * - `hide_ads`   — the feed is explicitly exempt.
 *
 * Output: one table per channel, plus a real check for the `stitched` marker in
 * the media playlist.
 */

import { hasAdMarkers, parseVariants } from "../src/lib/hls.js";
import { CLIENT_ID, readToken, tokenPayload, usherUrl } from "../src/lib/stream.js";

/** Every known pair, including the ones the extension does not use. */
const CANDIDATES = [
  ["site", "web"],
  ["popout", "web"],
  ["mobile_web", "web"],
  ["embed", "web"],
  ["frontpage", "web"],
  ["thunderdome", "web"],
  ["picture-by-picture", "web"],
  ["channel_home_carousel", "web"],
  ["autoplay", "web"],
  ["autoplay", "android"],
  ["site", "ios"],
  ["site", "android"],
  ["embed", "ios"],
  ["mobile_web", "ios"],
];

async function tokenFor(channel, playerType, platform) {
  const response = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-ID": CLIENT_ID, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(tokenPayload(channel, playerType, platform)),
  });
  if (!response.ok) return { error: `gql HTTP ${response.status}` };

  const text = await response.text();
  const token = readToken(text);
  if (!token) {
    let reason = "no token";
    try {
      const raw = JSON.parse(text);
      const entries = Array.isArray(raw) ? raw : [raw];
      const errors = entries.flatMap((e) => e.errors || []).map((e) => e.message);
      if (errors.length) reason = errors[0];
    } catch {
      /* unreadable response */
    }
    return { error: reason };
  }

  let fields = {};
  try {
    fields = JSON.parse(token.value);
  } catch {
    /* the token is not always readable JSON */
  }
  return { token, fields };
}

async function probe(channel, playerType, platform) {
  const { token, fields, error } = await tokenFor(channel, playerType, platform);
  if (error) return { label: `${playerType}/${platform}`, state: error };

  const row = {
    label: `${playerType}/${platform}`,
    server_ads: fields.server_ads,
    hide_ads: fields.hide_ads,
    subscriber: fields.subscriber,
  };

  const master = await fetch(usherUrl(channel, token.signature, token.value));
  if (!master.ok) return { ...row, state: `usher HTTP ${master.status}` };
  const variants = parseVariants(await master.text()).filter((v) => !v.isHevc);
  if (!variants.length) return { ...row, state: "no usable rendition" };

  const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  const media = await fetch(best.url);
  if (!media.ok) return { ...row, state: `media HTTP ${media.status}` };

  return {
    ...row,
    renditions: variants.length,
    max: best.name || best.resolution,
    state: hasAdMarkers(await media.text()) ? "STITCHED" : "clean",
  };
}

function column(value, width) {
  return String(value === undefined ? "-" : value).padEnd(width);
}

for (const channel of process.argv.slice(2)) {
  console.log(`\n=== ${channel} ===`);
  console.log(
    `${column("candidate", 26)}${column("server_ads", 11)}${column("hide_ads", 9)}${column("renditions", 11)}${column("max", 18)}state`,
  );
  const rows = await Promise.all(CANDIDATES.map(([p, f]) => probe(channel, p, f)));
  for (const row of rows) {
    console.log(
      `${column(row.label, 26)}${column(row.server_ads, 11)}${column(row.hide_ads, 9)}${column(row.renditions, 11)}${column(row.max, 18)}${row.state}`,
    );
  }
}
