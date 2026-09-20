/**
 * The hook as it runs inside the player's worker.
 *
 * It is given a fake `self`, the only way to check outside a browser that a
 * playlist comes back transformed and that everything else passes through.
 *
 * Two suites encode bugs found in live sessions that the offline tests of the
 * time could not see, because they described an imagined Twitch: the playlist
 * URLs, and the ban on writing to the player's message channel.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { channelFromUrl, isPlaylist, installHook } from "../src/worker/entry.js";
import { direct, master, preroll } from "./helpers.mjs";

const ORIGINE = "https://origine.example";
const URL_MEDIA = `${ORIGINE}/chunked.m3u8`;

// Taken from real traffic.
const VRAIE_MASTER =
  "https://usher.ttvnw.net/api/v2/channel/hls/demo_channel.m3u8?acmb=eyJBcHBWZXJzaW9uIjoiYjNhNjEy&allow_source=true";
const VRAIE_MEDIA = "https://euw32.playlist.ttvnw.net/v1/playlist/CpkHDFrrikny20MB2ApfsgFAnexAMJhqyexdx2lOk3G5d";
const VRAI_SEGMENT = "https://9f39f2.rufio.hls.live-video.net/v1/segment/CkBm9zcYCL49gp-7L_uTNsxZ";

function fakeScope(routes, { surDiffusion = () => {} } = {}) {
  const broadcast = [];
  const listeners = new Map();
  const scope = {
    broadcast,
    listeners,
    postMessage() {
      // The worker's channel belongs to the player: writing to it freezes playback.
      throw new Error("scope.postMessage must NEVER be used");
    },
    addEventListener: (type, cb) => listeners.set(type, cb),
    BroadcastChannel: class {
      constructor(nom) {
        this.nom = nom;
      }
      postMessage(message) {
        broadcast.push(message);
        surDiffusion(message);
      }
      addEventListener(type, cb) {
        listeners.set(`canal:${type}`, cb);
      }
      close() {}
    },
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      for (const [reason, body] of routes) {
        if (url.includes(reason)) return new Response(body, { status: 200 });
      }
      return new Response("", { status: 404 });
    },
  };
  return scope;
}

describe("recognising Twitch URLs (observed live)", () => {
  it("recognises the master under /api/v2/, not only /api/", () => {
    assert.equal(isPlaylist(VRAIE_MASTER), true);
    assert.equal(channelFromUrl(VRAIE_MASTER), "demo_channel");
    assert.equal(channelFromUrl("https://usher.ttvnw.net/api/channel/hls/Other_Channel.m3u8"), "other_channel");
  });

  it("recognises a media playlist with NO .m3u8 extension", () => {
    // The trap: filtering on ".m3u8" let every media playlist through.
    assert.equal(VRAIE_MEDIA.includes(".m3u8"), false);
    assert.equal(isPlaylist(VRAIE_MEDIA), true);
    assert.equal(channelFromUrl(VRAIE_MEDIA), "");
  });

  it("ignores segments, by far the most frequent requests", () => {
    assert.equal(isPlaylist(VRAI_SEGMENT), false);
    assert.equal(isPlaylist("https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min.wasm"), false);
  });
});

describe("interception inside the worker", () => {
  it("passes through anything that is not a playlist", async () => {
    const scope = fakeScope([["segment", "raw video bytes"]]);
    const { stop } = installHook(scope);
    assert.equal(await (await scope.fetch(VRAI_SEGMENT)).text(), "raw video bytes");
    stop();
  });

  it("leaves a non-HLS response alone", async () => {
    // The URL looks like a playlist but the body is not one.
    const scope = fakeScope([["/v1/playlist/", '{"erreur":"expire"}']]);
    const { stop } = installHook(scope);
    assert.equal(await (await scope.fetch(VRAIE_MEDIA)).text(), '{"erreur":"expire"}');
    stop();
  });

  it("drops HEVC from the master, recognised by its content", async () => {
    const scope = fakeScope([["/channel/hls/", master(ORIGINE)]]);
    const { stop } = installHook(scope);
    const texte = await (await scope.fetch(VRAIE_MASTER)).text();
    assert.equal(texte.includes("hvc1"), false);
    assert.ok(texte.includes("chunked.m3u8"));
    stop();
  });

  it("handles a media playlist served from an extension-less URL", async () => {
    const scope = fakeScope([
      ["/channel/hls/", master(ORIGINE)],
      ["gql", JSON.stringify({ data: {} })], // no token: no backup feed
      ["/v1/playlist/", preroll()],
    ]);
    const { stop } = installHook(scope);
    await scope.fetch(VRAIE_MASTER);
    const texte = await (await scope.fetch(VRAIE_MEDIA)).text();

    assert.ok(texte.includes("pub-0.ts"), "original playlist served as-is");
    assert.ok(scope.broadcast.some((m) => m.key === "ADS_Reload"), "a reload was requested");
    stop();
  });

  it("never breaks playback if the engine throws", async () => {
    const scope = fakeScope([["chunked.m3u8", direct()]]);
    const { blocker, stop } = installHook(scope);
    blocker.onMedia = () => {
      throw new Error("boum");
    };
    const reponse = await scope.fetch(URL_MEDIA);
    assert.equal(reponse.status, 200);
    assert.ok((await reponse.text()).includes("a-0.ts"), "the original body is returned");
    stop();
  });
});

describe("communication channel", () => {
  it("NEVER writes to the player's message channel", async () => {
    // `fakeScope.postMessage` throws: this test would have caught the frozen
    // player, which only showed up in a live session.
    const scope = fakeScope([["/v1/playlist/", direct()]]);
    const { stop } = installHook(scope);
    await scope.fetch(VRAIE_MEDIA);
    stop();
  });

  it("broadcasts on a private channel named by the page token", () => {
    const scope = fakeScope([]);
    scope.__ADS_REMOVE_TOKEN = "abc123";
    const { stop } = installHook(scope);
    assert.ok(scope.broadcast.some((m) => m.key === "ADS_Ready"));
    stop();
  });

  it("receives only the channel name, never credentials", () => {
    // The page's OAuth token no longer travels: backup requests are anonymous,
    // and a secret has no business on a same-origin channel.
    const scope = fakeScope([]);
    const { blocker, stop } = installHook(scope);
    const listener = scope.listeners.get("canal:message");
    assert.ok(listener, "the hook listens on the private channel");
    assert.equal(typeof blocker.majCredentials, "undefined", "no entry point any more");

    listener({ data: { key: "ADS_Channel", channel: "Demo_Channel" } });
    assert.equal(blocker.stats().channel, "demo_channel");

    listener({ data: { key: "something-else" } }); // must not break anything
    stop();
  });

  it("routes the learned order through to the engine", () => {
    // Routing is where this kind of feature dies: the value is computed in the
    // service worker and has four hops to cross before it means anything.
    const scope = fakeScope([]);
    const { blocker, stop } = installHook(scope);
    let taught = null;
    blocker.setRanking = (order) => {
      taught = order;
    };

    scope.listeners.get("canal:message")({
      data: { key: "ADS_Ranking", order: ["embed/web", "popout/web"] },
    });
    assert.deepEqual(taught, ["embed/web", "popout/web"]);
    stop();
  });
});

describe("off switch", () => {
  it("passes everything through when installed off", async () => {
    const body = preroll();
    const scope = fakeScope([["/v1/playlist/", body]]);
    const { stop } = installHook(scope, { enabled: false });

    const response = await scope.fetch(VRAIE_MEDIA);
    assert.equal(await response.text(), body, "the playlist is handed back untouched");
    // The preroll is the case that proves it: switched on, this body is the one
    // the engine cannot strip without emptying, so it always reacts to it.
    assert.equal(response.headers.get("X-Ads-Remove-Source"), null, "no response of ours");
    stop();
  });

  it("stops reading bodies altogether — not merely stops deciding", async () => {
    let bodiesRead = 0;
    const scope = fakeScope([]);
    const original = scope.fetch;
    scope.fetch = async (input) => {
      const response = await original(input);
      return new Proxy(response, {
        get(target, key) {
          if (key === "clone") bodiesRead += 1;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const { stop } = installHook(scope, { enabled: false });
    await scope.fetch(VRAIE_MEDIA);
    assert.equal(bodiesRead, 0, "switched off costs nothing");
    stop();
  });

  it("is flipped live from the page, both ways", async () => {
    const scope = fakeScope([["/v1/playlist/", preroll()]]);
    const { blocker, stop } = installHook(scope);
    const listener = scope.listeners.get("canal:message");

    listener({ data: { key: "ADS_Enabled", enabled: false } });
    assert.equal(blocker.stats().blocking, false);
    const off = await scope.fetch(VRAIE_MEDIA);
    assert.equal(off.headers.get("X-Ads-Remove-Source"), null, "nothing is substituted");

    listener({ data: { key: "ADS_Enabled", enabled: true } });
    assert.equal(blocker.stats().blocking, true, "and it comes back");
    stop();
  });

  it("reports no telemetry while off", async () => {
    const scope = fakeScope([]);
    const { stop } = installHook(scope, { enabled: false, telemetryMs: 5 });
    scope.broadcast.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(scope.broadcast.filter((m) => m.key === "ADS_Stats"), []);
    stop();
  });

  it("resumes reporting once switched back on", async () => {
    const scope = fakeScope([]);
    const { stop } = installHook(scope, { enabled: false, telemetryMs: 5 });
    scope.listeners.get("canal:message")({ data: { key: "ADS_Enabled", enabled: true } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(scope.broadcast.some((m) => m.key === "ADS_Stats"));
    stop();
  });
});

describe("backup requests are bounded", () => {
  it("carries a deadline, so one dead connection cannot hold the player", async () => {
    // Nothing else bounds them: the search runs every candidate through
    // Promise.all, and the player's own playlist request waits behind it. The
    // engine's FIRST_WAIT guard is a setTimeout, and Chrome throttles timers in
    // a hidden page — in a background tab it does not hold.
    const seen = [];
    const scope = fakeScope([["gql", "{}"], ["/v1/playlist/", direct()]]);
    const original = scope.fetch;
    scope.fetch = (input, init) => {
      seen.push(init || {});
      return original(input, init);
    };

    const { blocker, stop } = installHook(scope);
    blocker.setChannel("demo_channel");
    await blocker.onMedia("https://origine.example/chunked.m3u8", preroll());

    const backup = seen.filter((init) => init && init.credentials === "omit");
    assert.ok(backup.length, "the engine did reach the network");
    for (const init of backup) {
      assert.ok(init.signal, "a backup request went out with no deadline");
    }
    stop();
  });
});
