/**
 * HLS parsing, checked against real captured playlists — including a real
 * preroll. These fixtures are the reference for everything Twitch may change.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adSegments,
  hasAdMarkers,
  isAdBreak,
  isMaster,
  liveSegments,
  markDiscontinuity,
  parseAttributes,
  parseMedia,
  parseVariants,
  qualityLabel,
  readMediaSequence,
  rollType,
  stripAds,
  stripHevcVariants,
} from "../src/lib/hls.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const lire = (nom) => readFileSync(join(FIXTURES, nom), "utf8");

const MASTER = lire("master.m3u8");
const LIVE = lire("media-live.m3u8");
const MIDROLL = lire("media-midroll.m3u8");
const PREROLL = lire("real-preroll-2026-09.m3u8");

describe("parseAttributes", () => {
  it("keeps commas inside quoted values", () => {
    const attrs = parseAttributes('ID="a,b",CLASS="twitch-stitched-ad",DURATION=30.235');
    assert.equal(attrs.ID, "a,b");
    assert.equal(attrs.CLASS, "twitch-stitched-ad");
    assert.equal(attrs.DURATION, "30.235");
  });

  it("is reusable: the global regex keeps no state", () => {
    const premier = parseAttributes('A="1",B="2"');
    const second = parseAttributes('A="3",B="4"');
    assert.equal(premier.A, "1");
    assert.equal(second.A, "3");
  });
});

describe("master playlist", () => {
  it("recognises a master playlist", () => {
    assert.equal(isMaster(MASTER), true);
    assert.equal(isMaster(LIVE), false);
  });

  it("reads renditions and their readable names", () => {
    const variants = parseVariants(MASTER);
    assert.equal(variants.length, 4);
    assert.equal(qualityLabel(variants[0]), "1080p60 (source)");
    assert.equal(variants[0].resolution, "1920x1080");
    assert.equal(variants[0].bandwidth, 6208173);
    assert.deepEqual(
      variants.map((v) => v.isHevc),
      [false, false, false, true],
    );
  });

  it("drops HEVC and the orphaned #EXT-X-MEDIA tags", () => {
    const { text, removed } = stripHevcVariants(MASTER);
    assert.equal(removed, 1);
    assert.equal(parseVariants(text).length, 3);
    assert.equal(text.includes("chunked-hevc"), false);
    assert.equal(text.includes("CHUNKEDHEVC.m3u8"), false);
    // The remaining renditions are untouched.
    assert.equal(text.includes("CHUNKED.m3u8"), true);
    assert.equal(text.includes("360P30.m3u8"), true);
  });

  it("touches nothing when there is no HEVC", () => {
    const { text, removed } = stripHevcVariants(LIVE);
    assert.equal(removed, 0);
    assert.equal(text, LIVE);
  });
});

describe("media playlist", () => {
  it("sees no ad in a live playlist", () => {
    const playlist = parseMedia(LIVE);
    assert.equal(hasAdMarkers(LIVE), false);
    assert.equal(isAdBreak(playlist), false);
    assert.equal(adSegments(playlist).length, 0);
    assert.ok(liveSegments(playlist).length > 0);
  });

  it("counts one break across the seven DATERANGE tags of a real preroll", () => {
    const playlist = parseMedia(PREROLL);
    assert.equal(playlist.adBreaks.length, 1);
    assert.equal(rollType(playlist), "PREROLL");
    assert.equal(playlist.adBreaks[0].podLength, 1);
    assert.equal(Math.round(playlist.adBreaks[0].duration), 30);
  });

  it("classifies every preroll segment as an ad", () => {
    const playlist = parseMedia(PREROLL);
    assert.ok(playlist.segments.length > 0);
    assert.equal(liveSegments(playlist).length, 0, "a preroll contains no live content");
    assert.equal(adSegments(playlist).length, playlist.segments.length);
  });

  it("reads the media sequence reset to zero during the ad", () => {
    assert.equal(parseMedia(PREROLL).mediaSequence, 0);
  });
});

describe("end of break", () => {
  // The break's DATERANGE stays in the sliding window after the ad segments
  // are gone. Trusting it inflated the ad time reported and showed a 20s
  // preroll as lasting 44s.
  const TAG_PUB =
    '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",' +
    'START-DATE="2026-09-13T11:16:18.219Z",DURATION=20.0';

  const playlist = (...body) =>
    parseMedia(["#EXTM3U", "#EXT-X-VERSION:3", ...body].join("\n"));

  it("is over as soon as live content returns, tag or no tag", () => {
    const after = playlist(TAG_PUB, "#EXTINF:2.000,live", "https://cdn/a.ts");
    assert.equal(after.hasAdMarkers, true, "the tag is still around");
    assert.equal(isAdBreak(after), false, "but the break is over");
  });

  it("stays running while ad segments remain", () => {
    const during = playlist(
      TAG_PUB,
      "#EXTINF:2.000,Amazon|1",
      "https://cdn/pub.ts",
      "#EXTINF:2.000,live",
      "https://cdn/a.ts",
    );
    assert.equal(isAdBreak(during), true, "pub et direct melanges : brk en cours");
  });

  it("trusts the tag when no segment has arrived yet", () => {
    // Start of a break: the marker sometimes precedes the segments.
    assert.equal(isAdBreak(playlist(TAG_PUB)), true);
  });

  it("sees nothing in a live playlist with no tag", () => {
    assert.equal(isAdBreak(playlist("#EXTINF:2.000,live", "https://cdn/a.ts")), false);
  });
});

describe("stripAds", () => {
  it("strips midroll ad segments and keeps the live ones", () => {
    const before = parseMedia(MIDROLL);
    assert.ok(adSegments(before).length > 0);

    const { text, removed } = stripAds(MIDROLL);
    assert.equal(removed, adSegments(before).length);

    const after = parseMedia(text);
    assert.equal(adSegments(after).length, 0);
    assert.equal(after.segments.length, liveSegments(before).length);
  });

  it("removes the URL after the segment, not just the tag", () => {
    const { text } = stripAds(PREROLL);
    assert.equal(text.includes("/v1/segment/"), false);
  });

  it("disables prefetch during a break", () => {
    assert.equal(stripAds(MIDROLL).text.includes("#EXT-X-TWITCH-PREFETCH"), false);
  });

  it("raises the media sequence by the segments dropped from the head", () => {
    // HLS numbers the first segment of the playlist and the rest by position.
    // Dropping ads from the head renames everything after them: the player
    // receives the same segment under a new number on each poll, re-downloads
    // it, and the picture stops advancing until the break ends.
    const body = lire("media-midroll.m3u8");
    const before = readMediaSequence(body);
    const { text, removedBefore } = stripAds(body);

    assert.ok(removedBefore > 0, "the midroll starts with its ads");
    assert.equal(readMediaSequence(text), before + removedBefore);
  });

  it("leaves the sequence alone when only the tail was dropped", () => {
    const body = [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:500",
      "#EXTINF:2.000,live",
      "https://cdn.example/live-0.ts",
      "#EXTINF:2.000,Amazon|1",
      "https://cdn.example/pub-0.ts",
    ].join("\n");
    const { text, removed, removedBefore } = stripAds(body);
    assert.equal(removed, 1);
    assert.equal(removedBefore, 0, "nothing was dropped before the first kept segment");
    assert.equal(readMediaSequence(text), 500);
  });

  it("neutralises tracking URLs", () => {
    const { text } = stripAds(PREROLL);
    assert.equal(text.includes("X-TV-TWITCH-AD-CLICK-TRACKING-URL=\"https://twitch.tv\""), true);
    assert.equal(text.includes("X-TV-TWITCH-TRIGGER-URL=\"https://twitch.tv\""), true);
  });

  it("leaves a live playlist strictly untouched", () => {
    const { text, removed } = stripAds(LIVE);
    assert.equal(removed, 0);
    assert.equal(parseMedia(text).segments.length, parseMedia(LIVE).segments.length);
  });

  it("empties a preroll entirely: the case that breaks the player", () => {
    const { text, removed } = stripAds(PREROLL);
    assert.ok(removed > 0);
    assert.equal(parseMedia(text).segments.length, 0);
  });
});

describe("markDiscontinuity", () => {
  it("inserts the tag before the first segment", () => {
    const marque = markDiscontinuity(LIVE);
    const lignes = marque.split("\n");
    const index = lignes.findIndex((l) => l.startsWith("#EXTINF:"));
    assert.equal(lignes[index - 1], "#EXT-X-DISCONTINUITY");
  });

  it("does not duplicate an existing tag", () => {
    const once = markDiscontinuity(LIVE);
    assert.equal(markDiscontinuity(once), once);
  });

  it("leaves a segment-less playlist alone", () => {
    const empty = "#EXTM3U\n#EXT-X-VERSION:3\n";
    assert.equal(markDiscontinuity(empty), empty);
  });
});
