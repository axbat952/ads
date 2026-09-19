/**
 * Aggregation and formatting: what the user reads.
 *
 * Aggregation matters as much as the blocking itself — without it, every player
 * reload would reset the counters and the measurement would disappear.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregate,
  statusColour,
  breakElapsed,
  foldSilent,
  breakRemaining,
  emptyStats,
  badgeText,
  emptyTotals,
} from "../src/lib/aggregate.js";
import { channelTally, breakCountdown, lastBreakLine, status, formatDuration, tiles } from "../src/lib/view.js";

const report = (wid, receivedAt, stats) => ({ wid, receivedAt, stats });

describe("aggregation", () => {
  it("adds up counters across successive workers", () => {
    const total = aggregate(
      [
        report("w1", 10, { breaks: 3, swaps: 2, adTimeAvoided: 40, channel: "demo_channel" }),
        report("w2", 20, { breaks: 1, swaps: 1, adTimeAvoided: 12, channel: "demo_channel" }),
      ],
      300,
    );
    assert.equal(total.breaks, 4);
    assert.equal(total.swaps, 3);
    assert.equal(total.adTimeAvoided, 52);
    assert.equal(total.watchedFor, 300);
  });

  it("takes current state from the most recent report", () => {
    const total = aggregate([
      report("w1", 10, { inBreak: true, channel: "demo_channel", qualityRequested: "360p" }),
      report("w2", 20, { inBreak: false, channel: "other_channel", qualityRequested: "1080p60 (source)" }),
    ]);
    assert.equal(total.inBreak, false);
    assert.equal(total.channel, "other_channel");
    assert.equal(total.qualityRequested, "1080p60 (source)");
  });

  it("does not let an idle worker blank the current channel", () => {
    // The player creates TWO workers; only one sees playlists. The other also
    // reports every 2s and often speaks last: letting it win blanked the whole
    // display.
    const total = aggregate([
      report("w1", 20, { channel: "demo_channel", inBreak: true, breaks: 3 }),
      report("w2", 21, { channel: "", inBreak: false }),
    ]);
    assert.equal(total.channel, "demo_channel");
    assert.equal(total.inBreak, true);
    assert.equal(total.breaks, 3);
  });

  it("keeps the counters of a worker destroyed by a reload", () => {
    // This is the point of aggregation: the worker that counted the break
    // disappears on reload, and the new one starts from zero.
    const total = aggregate([
      report("ancien", 10, { breaks: 2, swaps: 1, reloads: 1, channel: "demo_channel" }),
      report("nouveau", 30, { breaks: 0, swaps: 0, reloads: 0, channel: "demo_channel" }),
    ]);
    assert.equal(total.breaks, 2);
    assert.equal(total.swaps, 1);
    assert.equal(total.reloads, 1);
  });

  it("merges the per-channel tally", () => {
    const total = aggregate([
      report("w1", 10, { tally: { demo_channel: [1, 2], other_channel: [3, 0] } }),
      report("w2", 20, { tally: { demo_channel: [0, 1] } }),
    ]);
    assert.deepEqual(total.tally, { demo_channel: [1, 3], other_channel: [3, 0] });
  });

  it("returns a coherent empty state before anything arrives", () => {
    const empty = aggregate([], 0);
    assert.deepEqual(empty, emptyStats());
    assert.equal(empty.breaks, 0);
    assert.equal(empty.channel, "");
  });
});

describe("break countdown", () => {
  const running = (startedAt, duration, spots = 1, roll = "MIDROLL") => ({
    inBreak: true,
    blocking: true,
    currentBreak: { startedAt, duration, spots, roll },
  });

  it("counts down from the start time, not from a local counter", () => {
    // The display stays correct even if a worker report is lost.
    const stats = running(1000, 30);
    assert.equal(breakCountdown(stats, 1010).remaining, 20);
    assert.equal(breakCountdown(stats, 1010).elapsed, 10);
    assert.equal(breakCountdown(stats, 1025).remaining, 5);
  });

  it("advances the progress bar proportionally", () => {
    const stats = running(1000, 40);
    assert.equal(breakCountdown(stats, 1000).fraction, 0);
    assert.equal(breakCountdown(stats, 1020).fraction, 0.5);
    assert.equal(breakCountdown(stats, 1060).fraction, 1, "jamais au-dela de 1");
  });

  it("stops promising once Twitch announcement is exceeded", () => {
    // The duration comes from the DATERANGE: an announcement, not a guarantee.
    const late = breakCountdown(running(1000, 30), 1045);
    assert.equal(late.remaining, 0);
    assert.equal(late.overrun, true);
    assert.ok(late.text.includes("45s elapsed"));
  });

  it("still says the essential without an announced duration", () => {
    const withoutDuration = breakCountdown(running(1000, 0), 1012);
    assert.equal(withoutDuration.remaining, null);
    assert.equal(withoutDuration.elapsed, 12);
  });

  it("shows nothing outside a break", () => {
    assert.equal(breakCountdown({ inBreak: false }), null);
    assert.equal(breakCountdown(emptyStats()), null);
  });

  it("reports the number of spots when there are several", () => {
    assert.ok(breakCountdown(running(1000, 60, 2), 1005).detail.includes("2 spots"));
    assert.ok(breakCountdown(running(1000, 30, 1), 1005).detail.includes("30s"));
  });

  it("exposes remaining and elapsed time for the badge", () => {
    const stats = running(1000, 30);
    assert.equal(breakRemaining(stats, 1012), 18);
    assert.equal(breakElapsed(stats, 1012), 12);
    assert.equal(breakRemaining({ inBreak: true }, 1012), null);
  });
});

describe("folding of vanished workers", () => {
  // The player creates one more worker on every reload. Without folding, the
  // list grows forever and the badge tick walks it every second.
  it("accumulates counters from workers that stopped reporting", () => {
    const { alive, totals } = foldSilent(
      [
        report("mort", 10, { breaks: 2, swaps: 1, tally: { demo_channel: [1, 1] } }),
        report("vivant", 100, { breaks: 1, swaps: 1 }),
      ],
      emptyTotals(),
      120,
      60,
    );
    assert.deepEqual(alive.map((r) => r.wid), ["vivant"]);
    assert.equal(totals.breaks, 2);
    assert.deepEqual(totals.tally, { demo_channel: [1, 1] });
  });

  it("forgets nothing: the total stays correct after folding", () => {
    const before = aggregate(
      [
        report("a", 10, { breaks: 2, adTimeAvoided: 30, tally: { demo_channel: [2, 0] } }),
        report("b", 100, { breaks: 1, adTimeAvoided: 10, tally: { demo_channel: [1, 0] } }),
      ],
      500,
    );
    const { alive, totals } = foldSilent(
      [
        report("a", 10, { breaks: 2, adTimeAvoided: 30, tally: { demo_channel: [2, 0] } }),
        report("b", 100, { breaks: 1, adTimeAvoided: 10, tally: { demo_channel: [1, 0] } }),
      ],
      emptyTotals(),
      120,
      60,
    );
    const after = aggregate(alive, 500, totals);
    assert.equal(after.breaks, before.breaks);
    assert.equal(after.adTimeAvoided, before.adTimeAvoided);
    assert.deepEqual(after.tally, before.tally);
  });

  it("counts the running total when no worker reports at all", () => {
    const { alive, totals } = foldSilent(
      [report("mort", 10, { breaks: 4, tally: { other_channel: [4, 0] } })],
      emptyTotals(),
      200,
      60,
    );
    assert.deepEqual(alive, []);
    const stats = aggregate(alive, 300, totals);
    assert.equal(stats.breaks, 4);
    assert.deepEqual(stats.tally, { other_channel: [4, 0] });
  });
});

describe("status dot and badge", () => {
  it("follows the state: grey, green, orange, red", () => {
    assert.equal(statusColour({ blocking: false }), "#808080");
    assert.equal(statusColour({ blocking: true, inBreak: false }), "#3cc86e");
    assert.equal(statusColour({ blocking: true, inBreak: true }), "#ffa500");
    assert.equal(statusColour({ blocking: true, inBreak: true, adNotBlocked: true }), "#e63c3c");
    assert.equal(statusColour({ blocking: true, frozenFor: 20 }), "#e63c3c");
  });

  it("carries the countdown during a break", () => {
    // Knowing whether playback resumes soon, without opening the popup.
    const stats = { blocking: true, inBreak: true, currentBreak: { startedAt: 1000, duration: 30 } };
    assert.equal(badgeText(stats, 1012), "18s");
    assert.ok(badgeText(stats, 1012).length <= 4);
    assert.equal(badgeText(stats, 1029), "1s");
  });

  it("fits in a badge", () => {
    assert.equal(badgeText({ blocking: true, inBreak: true }), "AD");
    assert.equal(badgeText({ blocking: true, breaks: 12 }), "12");
    assert.equal(badgeText({ blocking: true, breaks: 0 }), "");
    assert.ok(badgeText({ blocking: true, inBreak: true }).length <= 4);
  });
});

describe("formatting", () => {
  it("writes readable durations", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(12 * 60), "12 min");
    assert.equal(formatDuration(3600 + 4 * 60), "1h 04");
    assert.equal(formatDuration(-5), "0s");
  });

  it("explains the state in plain words, not jargon", () => {
    const replaced = status({ blocking: true, inBreak: true, backupFeeds: ["embed/web"] });
    assert.equal(replaced.title, "Ad running — replaced");
    assert.ok(replaced.detail.includes("embed/web"));

    const hidden = status({ blocking: true, inBreak: true, adNotBlocked: true });
    assert.equal(hidden.title, "Ad running — hidden");
    assert.ok(hidden.detail.includes("muted"), "it states what the user sees");
    assert.ok(hidden.detail.includes("reload"), "and what is attempted in parallel");

    assert.equal(status({ blocking: false }).title, "Switched off");
    assert.equal(status({ blocking: true }).title, "No ad");
  });

  it("shows the measurement that justifies the reload", () => {
    const avec = tiles({ reloads: 3, usefulReloads: 2 });
    const tile = avec.find((t) => t[1] === "Player reloads");
    assert.equal(tile[0], "3");
    assert.ok(tile[2].includes("2"));

    const sans = tiles({});
    assert.equal(sans.find((t) => t[1] === "Player reloads")[0], "0");
  });

  it("keeps only the six tiles one can act on", () => {
    // Last search duration, playlists replaced (73 for 4 breaks) and fruitless
    // searches are diagnostics: they belong in the log, not the main screen.
    const labels = tiles({}).map((t) => t[1]);
    assert.equal(labels.length, 6);
    assert.deepEqual(labels, [
      "Watch time",
      "Ad breaks handled",
      "Ad time avoided",
      "Ads let through",
      "Quality",
      "Player reloads",
    ]);
  });

  it("shows the quality swap in a single tile", () => {
    const same = tiles({ qualityRequested: "1080p60", qualityServed: ["1080p60"] });
    assert.equal(same.find((t) => t[1] === "Quality")[0], "1080p60");

    const different = tiles({ qualityRequested: "1080p60", qualityServed: ["720p60"] });
    assert.equal(different.find((t) => t[1] === "Quality")[0], "1080p60 → 720p60");
  });

  it("sorts the tally by busiest channel", () => {
    const lignes = channelTally({ tally: { a: [1, 0], b: [2, 5], c: [0, 2] } });
    assert.deepEqual(lignes[0], ["b", 2, 5]);
    assert.deepEqual(lignes.at(-1), ["a", 1, 0]);
  });

  it("summarises the last break", () => {
    assert.equal(lastBreakLine({}), "No ad break yet.");
    assert.equal(
      lastBreakLine({ lastBreak: { roll: "PREROLL", duration: 30.2, spots: 2 } }),
      "Last break: PREROLL, 30s, 2 spots",
    );
  });
});
