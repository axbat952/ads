/**
 * Searching for a clean feed: preference order honoured despite parallelism,
 * HEVC never retained, and silent failure rather than an exception.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKUP_CANDIDATES,
  LOW_QUALITY_CANDIDATES,
  cleanStreamFromMaster,
  findCleanStream,
  headers,
  candidateLabel,
  readToken,
  pickVariant,
  tokenPayload,
  usherUrl,
} from "../src/lib/stream.js";
import { parseVariants } from "../src/lib/hls.js";
import { direct, fetcher, master, preroll } from "./helpers.mjs";

describe("token request", () => {
  it("asks for a live stream with the intended playerType", () => {
    const payload = tokenPayload("demo_channel", "embed", "web");
    assert.equal(payload.variables.login, "demo_channel");
    assert.equal(payload.variables.playerType, "embed");
    assert.equal(payload.variables.isLive, true);
    assert.equal(payload.variables.isVod, false);
    assert.ok(payload.extensions.persistedQuery.sha256Hash);
  });

  it("reads the token whatever shape the response has", () => {
    const asObject = readToken(
      JSON.stringify({ data: { streamPlaybackAccessToken: { value: "v", signature: "s" } } }),
    );
    assert.deepEqual(asObject, { value: "v", signature: "s" });

    const asArray = readToken(
      JSON.stringify([{ data: { streamPlaybackAccessToken: { value: "v2", signature: "s2" } } }]),
    );
    assert.deepEqual(asArray, { value: "v2", signature: "s2" });

    assert.equal(readToken("not json"), null);
    assert.equal(readToken(JSON.stringify({ errors: [{ message: "boom" }] })), null);
  });

  it("never accepts HEVC from usher", () => {
    const url = usherUrl("demo_channel", "sig", "tok", () => 0.5);
    assert.equal(new URL(url).searchParams.get("supported_codecs"), "avc1");
    assert.equal(new URL(url).searchParams.get("allow_source"), "true");
  });
});

describe("candidate list", () => {
  it("excludes site/web: the only pair consistently stitched", () => {
    // It is the player's own playerType: a fresh site/web token arrives with
    // its ad. Measured across three live channels.
    const labels = BACKUP_CANDIDATES.map(candidateLabel);
    assert.equal(labels.includes("site/web"), false);
    assert.ok(labels.includes("popout/web"));
  });

  it("offers nine source-quality candidates, not four", () => {
    // The wider the list, the less likely the ad server catches them all at
    // once — the only case where the tool can do nothing.
    assert.equal(BACKUP_CANDIDATES.length, 9);
  });

  it("keeps degraded qualities apart, as a last resort", () => {
    const degraded = LOW_QUALITY_CANDIDATES.map(candidateLabel);
    assert.ok(degraded.includes("thunderdome/web"));
    // `autoplay` leaves the player loading forever: never offered.
    assert.equal([...BACKUP_CANDIDATES, ...LOW_QUALITY_CANDIDATES].some((c) => c.playerType === "autoplay"), false);
  });
});

describe("identity of backup requests", () => {
  it("sends NO identity header at all", () => {
    // Two reasons. It works better: measured on one channel, same instant,
    // same preroll — with identity headers, 11 candidates out of 11 came back
    // stitched; without them, a clean feed was found. And no secret is moved:
    // the OAuth token would otherwise travel over a same-origin channel.
    const sent = headers();
    assert.deepEqual(Object.keys(sent).sort(), ["Client-ID", "Content-Type"]);
    assert.equal(JSON.stringify(sent).toLowerCase().includes("authorization"), false);
  });

  it("makes a single pass, never an identified retry", async () => {
    const fake = fetcher({ clean: [] });
    const result = await findCleanStream("demo_channel", fake);
    assert.equal(result.stream, null);
    assert.equal(
      fake.calls.filter((a) => a.url.includes("gql")).length,
      BACKUP_CANDIDATES.length,
      "one pass and one only",
    );
  });
});

describe("pickVariant", () => {
  const variants = parseVariants(master("https://x"));

  it("honours the requested quality when it exists", () => {
    const wanted = variants.find((v) => v.resolution === "640x360");
    assert.equal(pickVariant(variants, wanted).resolution, "640x360");
  });

  it("takes the best below when the exact quality is missing", () => {
    const wanted = { resolution: "1600x900", bandwidth: 5_000_000 };
    assert.equal(pickVariant(variants, wanted).resolution, "1280x720");
  });

  it("takes the best available when nothing is requested", () => {
    assert.equal(pickVariant(variants, null).resolution, "1920x1080");
  });

  it("rules out HEVC even at the highest bitrate", () => {
    const wanted = { resolution: "2560x1440", bandwidth: 9_800_000 };
    assert.equal(pickVariant(variants, wanted).resolution, "1920x1080");
  });

  it("returns null when everything is HEVC", () => {
    const all = [{ resolution: "2560x1440", bandwidth: 1, codecs: "hvc1.2", isHevc: true }];
    assert.equal(pickVariant(all, null), null);
  });
});

describe("findCleanStream", () => {
  it("keeps the first clean candidate in preference order", async () => {
    // `popout` and `embed` are both clean: `popout` must win because it comes
    // first in the list, not because it answered first.
    const fake = fetcher({ clean: ["popout", "embed"], cleanBody: direct("popout") });
    const result = await findCleanStream("demo_channel", fake);
    assert.ok(result.stream);
    assert.equal(result.stream.playerType, "popout/web");
    assert.equal(result.stream.quality, "1080p60 (source)");
  });

  it("queries every candidate in parallel", async () => {
    const fake = fetcher({ clean: ["embed"] });
    await findCleanStream("demo_channel", fake);
    const gql = fake.calls.filter((a) => a.url.includes("gql"));
    assert.equal(gql.length, BACKUP_CANDIDATES.length);
  });

  it("returns a reasoned failure when every feed is stitched", async () => {
    const fake = fetcher({ clean: [], dirtyBody: preroll() });
    const result = await findCleanStream("demo_channel", fake);
    assert.equal(result.stream, null);
    assert.equal(result.attempts.length, BACKUP_CANDIDATES.length);
    for (const [label, reason] of result.attempts) {
      assert.ok(BACKUP_CANDIDATES.some((c) => candidateLabel(c) === label));
      assert.equal(reason, "feed is stitched too");
    }
  });

  it("never throws, even when the network blows up", async () => {
    const result = await findCleanStream("demo_channel", async () => {
      throw new Error("reseau coupe");
    });
    assert.equal(result.stream, null);
    assert.equal(result.attempts[0][1], "reseau coupe");
  });

  it("honours the requested quality in the backup feed", async () => {
    const fake = fetcher({ clean: ["popout"] });
    const wanted = parseVariants(master("https://origine")).find((v) => v.resolution === "1280x720");
    const result = await findCleanStream("demo_channel", fake, wanted);
    assert.equal(result.stream.variant.resolution, "1280x720");
    assert.equal(result.stream.quality, "720p60");
  });
});

describe("cleanStreamFromMaster", () => {
  it("avoids replaying the whole chain for another rendition", async () => {
    const fake = fetcher({ clean: ["popout"] });
    const flux = await cleanStreamFromMaster(
      "demo_channel",
      "popout/web",
      master("https://backup.example/popout"),
      fake,
      null,
    );
    assert.ok(flux);
    assert.equal(fake.calls.length, 1, "a single request, no GQL and no usher");
  });

  it("rejects a master whose feed got caught by ads", async () => {
    const fake = fetcher({ clean: [] });
    const flux = await cleanStreamFromMaster(
      "demo_channel",
      "popout/web",
      master("https://backup.example/popout"),
      fake,
      null,
    );
    assert.equal(flux, null);
  });
});
