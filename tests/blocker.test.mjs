/**
 * The decision engine — what the extension actually does during a break.
 *
 * Each test describes a situation seen in real captures: replaceable midroll,
 * unreplaceable midroll, full preroll, HEVC rendition.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backoffAfter, createBlocker } from "../src/lib/blocker.js";
import { parseMedia, readMediaSequence } from "../src/lib/hls.js";
import { direct, fetcher, clock, master, midroll, preroll } from "./helpers.mjs";

const ORIGINE = "https://origine.example";
const URL_MASTER = "https://usher.ttvnw.net/api/channel/hls/demo_channel.m3u8";
const URL_MEDIA = `${ORIGINE}/chunked.m3u8`;
const URL_HEVC = `${ORIGINE}/hevc.m3u8`;

function setup({ clean = [], options = {}, cleanBody = direct("clean") } = {}) {
  const time = clock();
  const reloads = [];
  const events = [];
  const fake = fetcher({ clean, cleanBody });
  const blocker = createBlocker({
    fetcher: fake,
    now: time.now,
    onReload: (reason) => {
      reloads.push(reason);
      return true;
    },
    onEvent: (ev) => events.push(ev),
    options,
  });
  blocker.onMaster(URL_MASTER, master(ORIGINE), "demo_channel");
  return { blocker, time, reloads, events, fake };
}

describe("master playlist", () => {
  it("drops HEVC renditions from the catalogue served to the player", () => {
    const { blocker } = setup();
    const output = blocker.onMaster(URL_MASTER, master(ORIGINE), "demo_channel");
    assert.equal(output.includes("hvc1"), false);
    assert.equal(output.includes("chunked.m3u8"), true);
  });

  it("leaves the catalogue untouched when the option is off", () => {
    const { blocker } = setup({ options: { dropHevc: false } });
    assert.equal(blocker.onMaster(URL_MASTER, master(ORIGINE), "demo_channel").includes("hvc1"), true);
  });
});

describe("live stream with no ads", () => {
  it("changes nothing", async () => {
    const { blocker } = setup();
    const body = direct();
    assert.equal(await blocker.onMedia(URL_MEDIA, body), body);
    const stats = blocker.stats();
    assert.equal(stats.breaks, 0);
    assert.equal(stats.inBreak, false);
    assert.equal(stats.channel, "demo_channel");
  });
});

describe("break with a replacement feed", () => {
  it("serves the clean feed and flags the discontinuity", async () => {
    const { blocker } = setup({ clean: ["popout"], cleanBody: direct("clean") });
    await blocker.onMedia(URL_MEDIA, direct());
    const output = await blocker.onMedia(URL_MEDIA, midroll());

    assert.ok(output.includes("clean-0.ts"), "the body comes from the backup feed");
    assert.equal(output.includes("pub-0.ts"), false);
    assert.ok(output.includes("#EXT-X-DISCONTINUITY"), "timeline change is flagged");

    const stats = blocker.stats();
    assert.equal(stats.breaks, 1);
    assert.equal(stats.swaps, 1);
    assert.equal(stats.adsLetThrough, 0);
    assert.deepEqual(stats.backupFeeds, ["popout/web"]);
    assert.deepEqual(stats.tally, { demo_channel: [1, 0] });
  });

  it("reports the kind of break to the page", async () => {
    // The break's `type` field (PREROLL/MIDROLL) used to overwrite the event
    // type, so the page never saw a single break go by.
    const { blocker, events } = setup({ clean: ["popout"] });
    await blocker.onMedia(URL_MEDIA, midroll());
    const brk = events.find((e) => e.type === "break");
    assert.ok(brk, "the event keeps its own type");
    assert.equal(brk.roll, "MIDROLL");
    assert.equal(blocker.stats().lastBreak.roll, "MIDROLL", "one name everywhere");
    assert.equal(brk.spots, 2);
  });

  it("counts one break even if the player polls ten times", async () => {
    const { blocker } = setup({ clean: ["popout"] });
    for (let i = 0; i < 10; i += 1) await blocker.onMedia(URL_MEDIA, midroll());
    assert.equal(blocker.stats().breaks, 1);
    assert.deepEqual(blocker.stats().tally, { demo_channel: [1, 0] });
  });

  it("hands back to the original feed at the end, with a discontinuity", async () => {
    const { blocker } = setup({ clean: ["popout"] });
    await blocker.onMedia(URL_MEDIA, midroll());
    const back = await blocker.onMedia(URL_MEDIA, direct("after"));
    assert.ok(back.includes("after-0.ts"));
    assert.ok(back.includes("#EXT-X-DISCONTINUITY"));
  });

  it("never asks for a reload when the swap works", async () => {
    const { blocker, reloads } = setup({ clean: ["popout"] });
    await blocker.onMedia(URL_MEDIA, midroll());
    assert.deepEqual(reloads, []);
  });
});

describe("channel known without a master playlist", () => {
  // The player does not always re-request the master (cached response, in-app
  // navigation). The break was then known without any way to search for a
  // backup feed, for lack of knowing which channel to ask for.
  function withoutMaster({ clean = [] } = {}) {
    const time = clock();
    const fake = fetcher({ clean, cleanBody: direct("clean") });
    const blocker = createBlocker({ fetcher: fake, now: time.now });
    return { blocker, fake, time };
  }

  it("searches for nothing until a channel is known", async () => {
    const { blocker, fake } = withoutMaster({ clean: ["popout"] });
    await blocker.onMedia(URL_MEDIA, midroll());
    assert.equal(fake.calls.length, 0, "no request: we do not know what to ask for");
  });

  it("swaps as soon as the page announces the channel", async () => {
    const { blocker } = withoutMaster({ clean: ["popout"] });
    blocker.setChannel("Demo_Channel");
    const output = await blocker.onMedia(URL_MEDIA, midroll());
    assert.ok(output.includes("clean-0.ts"), "the backup feed is served");
    assert.equal(blocker.stats().channel, "demo_channel", "normalised to lower case");
  });

  it("forgets the previous channel's clean feed on a change", async () => {
    const { blocker } = withoutMaster({ clean: ["popout"] });
    blocker.setChannel("first_channel");
    await blocker.onMedia(URL_MEDIA, midroll());
    blocker.setChannel("second_channel");
    assert.equal(blocker.stats().channel, "second_channel");
  });
});

describe("media sequence continuity", () => {
  // Every Twitch session has its own numbering (a preroll restarts at zero).
  // Handing the player a live playlist whose sequence goes BACKWARDS makes it
  // consider the playlist stale: it waits, which looks like a load that never
  // finishes when the break ends.
  const withSequence = (body, n) =>
    body.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, `#EXT-X-MEDIA-SEQUENCE:${n}`);

  it("never lets the numbering go backwards when live returns", async () => {
    // Backup feed far ahead of the original: the exact trap.
    const { blocker } = setup({
      clean: ["popout"],
      cleanBody: withSequence(direct("clean"), 90000),
    });

    const before = await blocker.onMedia(URL_MEDIA, withSequence(direct(), 8421));
    const during = await blocker.onMedia(URL_MEDIA, withSequence(midroll(), 8430));
    const after = await blocker.onMedia(URL_MEDIA, withSequence(direct("after"), 8440));

    const sequence = [before, during, after].map(readMediaSequence);
    assert.ok(sequence[1] > sequence[0], `the backup must move forward (${sequence})`);
    assert.ok(sequence[2] > sequence[1], `and so must the return to live (${sequence})`);
  });

  it("touches nothing while the source never changed", async () => {
    const { blocker } = setup({ clean: [] });
    const body = withSequence(direct(), 8421);
    const output = await blocker.onMedia(URL_MEDIA, body);
    assert.equal(output, body, "a live playlist with no break comes out unchanged");
  });

  it("keeps the numbering increasing after the break ends", async () => {
    const { blocker } = setup({
      clean: ["popout"],
      cleanBody: withSequence(direct("clean"), 90000),
    });
    await blocker.onMedia(URL_MEDIA, withSequence(midroll(), 8430));

    // Several live polls after the break: the sequence must keep increasing,
    // not only on the first return.
    const sequence = [];
    for (let i = 0; i < 4; i += 1) {
      sequence.push(readMediaSequence(await blocker.onMedia(URL_MEDIA, withSequence(direct(), 8440 + i))));
    }
    for (let i = 1; i < sequence.length; i += 1) {
      assert.ok(sequence[i] > sequence[i - 1], `poll ${i} recule : ${sequence}`);
    }
  });
});

describe("break with no replacement feed", () => {
  it("strips ad segments when live content remains", async () => {
    const { blocker } = setup({ clean: [] });
    const output = await blocker.onMedia(URL_MEDIA, midroll());

    assert.equal(output.includes("pub-0.ts"), false);
    assert.ok(output.includes("live-0.ts"));
    assert.equal(output.includes("#EXT-X-TWITCH-PREFETCH"), false);
    assert.equal(blocker.stats().strippedSegments, 2);
    assert.equal(blocker.stats().swaps, 0);
  });

  it("lets a full preroll through rather than breaking the player", async () => {
    const { blocker } = setup({ clean: [] });
    const entree = preroll();
    const output = await blocker.onMedia(URL_MEDIA, entree);

    // The original playlist is served as-is: an empty one would send the
    // player to the streamer's offline screen.
    assert.ok(output.includes("pub-0.ts"));
    assert.ok(parseMedia(output).segments.length > 0);

    const stats = blocker.stats();
    assert.equal(stats.adsLetThrough, 1);
    assert.equal(stats.adNotBlocked, true);
    assert.deepEqual(stats.tally, { demo_channel: [0, 1] });
  });

  it("tells the page to hide the ad", async () => {
    // The live stream cannot be restored during an SSAI break, but the ad can
    // be kept off screen. That is what makes behaviour uniform across every
    // channel, including those where nothing is replaceable.
    const { blocker, events } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, preroll());

    const overlay = events.find((e) => e.type === "adLetThrough");
    assert.ok(overlay, "the page is notified");
    assert.equal(Math.round(overlay.duration), 30, "with the duration Twitch announced");

    // Once per break, not on every poll.
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(events.filter((e) => e.type === "adLetThrough").length, 1);
  });

  it("tells the page the break is over, so the overlay goes", async () => {
    const { blocker, events } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, preroll());
    await blocker.onMedia(URL_MEDIA, direct());
    assert.ok(events.some((e) => e.type === "breakOver"));
  });

  it("asks for a player reload", async () => {
    const { blocker, reloads } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.deepEqual(reloads, ["whole playlist is ads"]);
    assert.equal(blocker.stats().reloads, 1);
  });
});

describe("ad time accounting", () => {
  it("stops counting a URL the player abandoned", async () => {
    // A URL abandoned mid-break (quality change, CDN rotation) stayed flagged
    // as "in a break" forever: the counter ran continuously and reported 12
    // minutes of ads for 13 minutes of watching.
    const { blocker, time } = setup({ clean: [] });
    await blocker.onMedia(`${ORIGINE}/abandonnee.m3u8`, midroll());

    // The player switches rendition and stops polling the first one.
    for (let i = 0; i < 12; i += 1) {
      time.t += 5;
      await blocker.onMedia(URL_MEDIA, direct());
    }

    const stats = blocker.stats();
    assert.equal(stats.inBreak, false);
    assert.ok(
      stats.adTimeAvoided < 20,
      `the counter must not run continuously (${stats.adTimeAvoided}s)`,
    );
  });
});

describe("internal state bounds", () => {
  it("does not accumulate state over a long session", async () => {
    // Thirteen parallel maps on the same key: two had already escaped pruning.
    // A single map makes that impossible — but it still has to be checked.
    const { blocker, time } = setup({ clean: [] });
    for (let i = 0; i < 200; i += 1) {
      time.t += 1;
      await blocker.onMedia(`${ORIGINE}/rendition-${i}.m3u8`, direct());
    }
    const stats = blocker.stats();
    assert.ok(stats.trackedUrls <= 64, `etat borne (${stats.trackedUrls} URL suivies)`);
  });

  it("bounds the backup body cache too", async () => {
    // This cache is not keyed by playlist URL: it escaped pruning and grew on
    // every break.
    const { blocker, time } = setup({ clean: ["popout"] });
    for (let i = 0; i < 5; i += 1) {
      await blocker.onMedia(`${ORIGINE}/q${i}.m3u8`, midroll());
      time.t += 60; // well past the expiry of a memorised body
    }
    await blocker.onMedia(URL_MEDIA, direct());
    assert.ok(blocker.stats().cachedBodies <= 1, "stale bodies are forgotten");
  });
});

describe("per-channel tally", () => {
  it("does not double-count a break that changes verdict", async () => {
    // Let through on the first pass, replaced as soon as a clean feed appears:
    // that is ONE break. Counting it in both columns inflated the very table
    // used to decide.
    const time = clock();
    let clean = [];
    const fake = fetcher({ clean: [] });
    const evolving = async (method, url, headers, body) => {
      if (url.includes("backup.example")) {
        const type = url.split("/")[3];
        return { status: 200, text: clean.includes(type) ? direct("clean") : preroll() };
      }
      return fake(method, url, headers, body);
    };
    const blocker = createBlocker({ fetcher: evolving, now: time.now });
    blocker.onMaster(URL_MASTER, master(ORIGINE), "demo_channel");

    await blocker.onMedia(URL_MEDIA, preroll());
    assert.deepEqual(blocker.stats().tally, { demo_channel: [0, 1] }, "let through");

    clean = ["popout"];
    time.t += 30;
    await blocker.onMedia(URL_MEDIA, preroll());

    const tally = blocker.stats().tally;
    assert.deepEqual(tally, { demo_channel: [1, 0] }, "the verdict is corrected, not duplicated");
    assert.equal(tally.demo_channel[0] + tally.demo_channel[1], 1, "still a single break");
  });
});

describe("reported requested quality", () => {
  it("points at the most recently seen rendition", async () => {
    // The old walk followed insertion order, showing an arbitrary active
    // rendition — hence "640x360 requested" while source was being served.
    const { blocker, time } = setup({ clean: [] });
    const source = `${ORIGINE}/chunked.m3u8`;
    const basse = `${ORIGINE}/360p30.m3u8`;

    await blocker.onMedia(source, direct());
    time.t += 1;
    await blocker.onMedia(basse, direct());
    assert.equal(blocker.stats().qualityRequested, "360p", "the most recent one");

    time.t += 1;
    await blocker.onMedia(source, direct());
    assert.equal(blocker.stats().qualityRequested, "1080p60 (source)");
  });
});

describe("back-off between searches", () => {
  it("doubles the wait on each failure, then caps it", () => {
    assert.equal(backoffAfter(1), 5);
    assert.equal(backoffAfter(2), 10);
    assert.equal(backoffAfter(3), 20);
    assert.equal(backoffAfter(10), 60, "plafonne");
  });

  it("really spaces out searches through an unblockable break", async () => {
    // Eleven candidates times three requests per search: without back-off, a
    // long break produced hundreds of requests per minute for nothing.
    const { blocker, fake, time } = setup({ clean: [] });
    const searchCount = () => new Set(fake.calls.filter((a) => a.url.includes("gql")).map((a) => a.body)).size;

    await blocker.onMedia(URL_MEDIA, preroll());
    const afterFirst = fake.calls.length;

    // 6s later: the first wait (5s) has elapsed, so a retry goes out.
    time.t += 6;
    await blocker.onMedia(URL_MEDIA, preroll());
    const afterSecond = fake.calls.length;
    assert.ok(afterSecond > afterFirst, "un second essai a bien eu lieu");

    // 6s more: the wait is now 10s, so nothing goes out.
    time.t += 6;
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(fake.calls.length, afterSecond, "too early for a third attempt");
    assert.ok(searchCount() > 0);
  });

  it("starts from a short wait again on the next break", async () => {
    const { blocker, fake, time } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, preroll());
    time.t += 6;
    await blocker.onMedia(URL_MEDIA, preroll());
    const before = fake.calls.length;

    await blocker.onMedia(URL_MEDIA, direct()); // fin de brk
    time.t += 6;
    await blocker.onMedia(URL_MEDIA, preroll()); // nouvelle brk
    assert.ok(fake.calls.length > before, "the new break retries immediately");
  });
});

describe("reload guard rails", () => {
  it("respects the cooldown between two reloads", async () => {
    const { blocker, time, reloads } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(reloads.length, 1);

    // Next poll, still the same break: too early.
    time.t += 2;
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(reloads.length, 1);

    time.t += 30;
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(reloads.length, 2);
  });

  it("never reloads more than twice for one break", async () => {
    const { blocker, time, reloads } = setup({ clean: [] });
    for (let i = 0; i < 6; i += 1) {
      await blocker.onMedia(URL_MEDIA, preroll());
      time.t += 30;
    }
    assert.equal(reloads.length, 2);
  });

  it("allows two reloads again on the next break", async () => {
    const { blocker, time, reloads } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, preroll());
    time.t += 30;
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(reloads.length, 2);

    // Break ends, then a new one starts.
    await blocker.onMedia(URL_MEDIA, direct());
    time.t += 30;
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(reloads.length, 3);
  });

  it("calls nothing when the option is off", async () => {
    const { blocker, reloads } = setup({ clean: [], options: { reloadPlayer: false } });
    await blocker.onMedia(URL_MEDIA, preroll());
    assert.deepEqual(reloads, []);
    assert.equal(blocker.stats().reloads, 0);
  });

  it("measures which reloads actually led to a clean feed", async () => {
    const time = clock();
    const reloads = [];
    // Twitch only returns a clean feed after the reload: exactly the bet the
    // extension makes, and the only way to know whether it pays off.
    let clean = [];
    const fake = fetcher({ clean: [] });
    const fetcherEvolutif = async (method, url, headers, body) => {
      if (url.includes("backup.example")) {
        const type = url.split("/")[3];
        return { status: 200, text: clean.includes(type) ? direct("clean") : preroll() };
      }
      return fake(method, url, headers, body);
    };

    const blocker = createBlocker({
      fetcher: fetcherEvolutif,
      now: time.now,
      onReload: (reason) => {
        reloads.push(reason);
        clean = ["popout"]; // the new session is not stitched
        return true;
      },
    });
    blocker.onMaster(URL_MASTER, master(ORIGINE), "demo_channel");

    await blocker.onMedia(URL_MEDIA, preroll());
    assert.equal(reloads.length, 1);
    assert.equal(blocker.stats().usefulReloads, 0);

    // Past the guard delay that follows a fruitless search.
    time.t += 6;
    await blocker.onMedia(URL_MEDIA, preroll());
    const stats = blocker.stats();
    assert.equal(stats.swaps, 1);
    assert.equal(stats.usefulReloads, 1, "the reload counts as useful");
  });
});

describe("HEVC rendition", () => {
  it("attempts no substitution: the decoder cannot change codec", async () => {
    const { blocker, fake } = setup({ clean: ["popout"] });
    const output = await blocker.onMedia(URL_HEVC, midroll());

    assert.equal(fake.calls.length, 0, "no backup search at all");
    assert.equal(output.includes("pub-0.ts"), false, "the ad is stripped");
    assert.ok(output.includes("live-0.ts"));
  });
});

describe("monitoring mode", () => {
  it("changes nothing when blocking is off", async () => {
    const { blocker } = setup({ clean: ["popout"], options: { block: false } });
    const body = midroll();
    assert.equal(await blocker.onMedia(URL_MEDIA, body), body);
    assert.equal(blocker.stats().breaks, 1, "counting continues");
    assert.equal(blocker.stats().blocking, false);
  });

  it("is switched off and back on without rebuilding the engine", async () => {
    const { blocker } = setup({ clean: ["popout"] });
    const body = midroll();

    blocker.setEnabled(false);
    assert.equal(blocker.stats().blocking, false);
    assert.equal(await blocker.onMedia(URL_MEDIA, body), body, "handed back untouched");

    blocker.setEnabled(true);
    assert.equal(blocker.stats().blocking, true);
    const output = await blocker.onMedia(URL_MEDIA, body);
    assert.equal(output.includes("pub-0.ts"), false, "and it blocks again at once");
  });
});

describe("resilience", () => {
  it("serves the original feed if the network dies mid-search", async () => {
    const time = clock();
    const blocker = createBlocker({
      fetcher: async () => {
        throw new Error("reseau coupe");
      },
      now: time.now,
    });
    blocker.onMaster(URL_MASTER, master(ORIGINE), "demo_channel");
    const output = await blocker.onMedia(URL_MEDIA, midroll());
    assert.ok(output.includes("live-0.ts"));
    assert.equal(blocker.stats().failedSearches, 1);
  });

  it("does not restart a search during the guard delay", async () => {
    const { blocker, fake, time } = setup({ clean: [] });
    await blocker.onMedia(URL_MEDIA, midroll());
    const afterFirst = fake.calls.length;
    assert.ok(afterFirst > 0);

    time.t += 1;
    await blocker.onMedia(URL_MEDIA, midroll());
    assert.equal(fake.calls.length, afterFirst, "aucune nouvelle recherche");

    time.t += 10;
    await blocker.onMedia(URL_MEDIA, midroll());
    assert.ok(fake.calls.length > afterFirst, "the guard delay has elapsed");
  });
});
