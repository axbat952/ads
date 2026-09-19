/**
 * The learned order of backup sources.
 *
 * What is being checked is not the arithmetic but the two properties that make
 * the mechanism safe: it must never bury a candidate it has not tried, and it
 * must forget. A ranking that gets either wrong degrades silently — the engine
 * would keep working while quietly asking the wrong sources first.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANY_CHANNEL,
  CHANNEL_TTL,
  COUNT_CAP,
  MAX_CHANNELS,
  emptyRanking,
  orderLabels,
  pruneRanking,
  recordOutcomes,
  scoreFor,
} from "../src/lib/ranking.js";
import { BACKUP_CANDIDATES, candidateLabel, orderCandidates } from "../src/lib/stream.js";

const LABELS = BACKUP_CANDIDATES.map(candidateLabel);

/** Fold the same verdict `times` times, as a run of identical breaks would. */
function repeat(ranking, channel, outcomes, times, at = 0) {
  let out = ranking;
  for (let i = 0; i < times; i += 1) out = recordOutcomes(out, channel, outcomes, at);
  return out;
}

describe("evidence", () => {
  it("does not touch the record it was given", () => {
    const before = recordOutcomes(emptyRanking(), "demo", [["popout/web", true]], 10);
    const snapshot = JSON.stringify(before);
    recordOutcomes(before, "demo", [["popout/web", false]], 20);
    assert.equal(JSON.stringify(before), snapshot, "folding a search rewrites nothing");
  });

  it("counts the winner too, not only the candidates that failed before it", () => {
    // `attempts` stops at the winner; `outcomes` does not. Scoring on attempts
    // would punish every candidate listed after the first success.
    const ranking = recordOutcomes(
      emptyRanking(),
      "demo",
      [["site/web", false], ["popout/web", true], ["embed/web", true]],
      10,
    );
    const sources = ranking.demo.sources;
    assert.deepEqual([sources["popout/web"].ok, sources["popout/web"].ko], [1, 0]);
    assert.deepEqual([sources["embed/web"].ok, sources["embed/web"].ko], [1, 0]);
    assert.deepEqual([sources["site/web"].ok, sources["site/web"].ko], [0, 1]);
  });

  it("keeps a global record alongside the per-channel one", () => {
    const ranking = recordOutcomes(emptyRanking(), "demo", [["popout/web", true]], 10);
    assert.equal(ranking[ANY_CHANNEL].sources["popout/web"].ok, 1);
  });

  it("normalises the channel name", () => {
    const ranking = recordOutcomes(emptyRanking(), "Demo_Channel", [["popout/web", true]], 10);
    assert.ok(ranking.demo_channel, "stored in lower case");
  });

  it("ignores a search with nothing in it", () => {
    assert.deepEqual(recordOutcomes(emptyRanking(), "demo", [], 10), {});
    assert.deepEqual(recordOutcomes(emptyRanking(), "", [["a", true]], 10), {});
  });

  it("forgets the distant past by halving once past the cap", () => {
    // A source that worked for a month then broke must not stay on top for the
    // rest of the month: its history is bounded, so recent failures can win.
    let ranking = repeat(emptyRanking(), "demo", [["popout/web", true]], COUNT_CAP + 4, 10);
    const entry = ranking.demo.sources["popout/web"];
    assert.ok(entry.ok + entry.ko <= COUNT_CAP + 1, `bounded (${entry.ok + entry.ko})`);

    ranking = repeat(ranking, "demo", [["popout/web", false]], 14, 20);
    assert.ok(
      scoreFor(ranking, "demo", "popout/web") < 0.5,
      "two weeks of failure outvote a month of success",
    );
  });
});

describe("ordering", () => {
  it("leaves the hand-picked order alone when nothing is known", () => {
    assert.deepEqual(orderLabels(LABELS, emptyRanking(), "demo"), LABELS);
  });

  it("puts a source that works first, and one that never does last", () => {
    let ranking = repeat(emptyRanking(), "demo", [["embed/web", true]], 6, 10);
    ranking = repeat(ranking, "demo", [["popout/web", false]], 6, 10);
    const order = orderLabels(LABELS, ranking, "demo");
    assert.equal(order[0], "embed/web");
    assert.equal(order[order.length - 1], "popout/web");
  });

  it("never buries a candidate it has not tried", () => {
    // The property that keeps the list open: a new `playerType` added to
    // `stream.js` must be tried, not condemned by silence.
    let ranking = repeat(emptyRanking(), "demo", [["popout/web", false]], 10, 10);
    const order = orderLabels(LABELS, ranking, "demo");
    const untried = LABELS.filter((l) => l !== "popout/web");
    assert.ok(
      order.indexOf("popout/web") > order.indexOf(untried[untried.length - 1]),
      "the proven failure ranks below every unknown",
    );
  });

  it("carries what it learned elsewhere to a channel it has never seen", () => {
    const ranking = repeat(emptyRanking(), "other", [["mobile_web/web", true]], 8, 10);
    assert.equal(orderLabels(LABELS, ranking, "brand_new")[0], "mobile_web/web");
  });

  it("lets a channel's own evidence outweigh that reputation", () => {
    let ranking = repeat(emptyRanking(), "other", [["mobile_web/web", true]], 12, 10);
    ranking = repeat(ranking, "demo", [["mobile_web/web", false]], 8, 10);
    assert.ok(
      orderLabels(LABELS, ranking, "demo").indexOf("mobile_web/web") > 0,
      "stitched here, whatever it does elsewhere",
    );
    assert.equal(orderLabels(LABELS, ranking, "other")[0], "mobile_web/web");
  });

  it("is stable: equal scores keep the order they were given", () => {
    const ranking = recordOutcomes(emptyRanking(), "demo", LABELS.map((l) => [l, false]), 10);
    assert.deepEqual(orderLabels(LABELS, ranking, "demo"), LABELS);
  });
});

describe("applying the order to real candidates", () => {
  it("reorders without dropping anything", () => {
    const order = ["embed/web", "site/ios"];
    const out = orderCandidates(BACKUP_CANDIDATES, order);
    assert.equal(out.length, BACKUP_CANDIDATES.length, "no candidate is lost");
    assert.deepEqual(out.slice(0, 2).map(candidateLabel), order);
  });

  it("keeps a label the order has never heard of, at the end", () => {
    // The order can go stale against a newer candidate list. It must never make
    // a candidate unreachable.
    const out = orderCandidates(BACKUP_CANDIDATES, ["embed/web"]);
    assert.equal(out.length, BACKUP_CANDIDATES.length);
    assert.deepEqual(
      out.slice(1).map(candidateLabel),
      BACKUP_CANDIDATES.map(candidateLabel).filter((l) => l !== "embed/web"),
      "the rest keeps its own order",
    );
  });

  it("changes nothing when there is no order", () => {
    assert.equal(orderCandidates(BACKUP_CANDIDATES, []), BACKUP_CANDIDATES);
    assert.equal(orderCandidates(BACKUP_CANDIDATES, null), BACKUP_CANDIDATES);
  });
});

describe("bounds", () => {
  it("forgets channels left untouched for a month", () => {
    let ranking = recordOutcomes(emptyRanking(), "old", [["popout/web", true]], 0);
    ranking = recordOutcomes(ranking, "recent", [["popout/web", true]], CHANNEL_TTL);
    const kept = pruneRanking(ranking, CHANNEL_TTL + 1);
    assert.equal(kept.old, undefined);
    assert.ok(kept.recent, "and keeps the one still in use");
  });

  it("never drops what it learned globally", () => {
    const ranking = recordOutcomes(emptyRanking(), "old", [["popout/web", true]], 0);
    const kept = pruneRanking(ranking, CHANNEL_TTL * 10);
    assert.ok(kept[ANY_CHANNEL], "the prior survives the channels it came from");
  });

  it("caps the number of channels, oldest first", () => {
    let ranking = emptyRanking();
    for (let i = 0; i < MAX_CHANNELS + 5; i += 1) {
      ranking = recordOutcomes(ranking, `c${i}`, [["popout/web", true]], i);
    }
    const kept = pruneRanking(ranking, MAX_CHANNELS + 5);
    assert.equal(Object.keys(kept).length, MAX_CHANNELS + 1, "channels plus the global bucket");
    assert.equal(kept.c0, undefined);
    assert.ok(kept[`c${MAX_CHANNELS + 4}`]);
  });
});
