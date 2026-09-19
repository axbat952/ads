/**
 * The build is the one place where a bug is invisible: a syntactically broken
 * bundle raises nothing here, only a player that blocks nothing. Hence these
 * checks.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { build, workerPayload } from "../build.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const lire = (relatif) => readFileSync(join(DIST, relatif), "utf8");

describe("worker preamble", () => {
  const payload = workerPayload();

  it("is valid JavaScript", () => {
    // `new Function` compiles without executing: exactly what we want to check.
    assert.doesNotThrow(() => new Function(payload));
  });

  it("contains no import or export any more", () => {
    assert.equal(/^\s*(import|export)\s/m.test(payload), false);
  });

  it("is wrapped in an IIFE, so it never shares Twitch scope", () => {
    assert.ok(payload.startsWith("(() => {"));
    assert.ok(payload.trimEnd().endsWith("})();"));
  });

  it("starts in the state the page was in, not on the default", () => {
    // The switch was cosmetic for one release because the payload ignored it:
    // every worker the player built after the flip started enabled again.
    assert.ok(
      workerPayload().includes("__ADS_REMOVE_ENABLED"),
      "the worker must read the switch the page injected",
    );
  });

  it("bundles the engine, not just the hook", () => {
    assert.ok(payload.includes("createBlocker"));
    assert.ok(payload.includes("stitched"), "the detection marker is present");
    assert.ok(payload.includes("PlaybackAccessToken"));
  });
});

describe("built extension", () => {
  it("produces every file the manifest declares", () => {
    build();
    const manifestJson = JSON.parse(lire("manifest.json"));
    assert.equal(manifestJson.manifest_version, 3);

    const expectedFiles = [
      manifestJson.background.service_worker,
      manifestJson.action.default_popup,
      ...manifestJson.content_scripts.flatMap((c) => c.js),
      ...Object.values(manifestJson.icons),
    ];
    for (const file of expectedFiles) {
      assert.doesNotThrow(() => readFileSync(join(DIST, file)), `${file} manquant`);
    }
  });

  it("ships every module the built code imports", () => {
    // The service worker and the popup load ES modules that the manifest never
    // names, so the copy list in `build.mjs` is the only thing keeping them
    // present. Forgetting one breaks the extension at load with nothing to
    // catch it: adding `lib/ranking.js` nearly went out that way.
    build();
    const entries = ["background.js", "popup/popup.js"];
    const seen = new Set();

    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(join(DIST, file), "utf8");
      const from = dirname(file);
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = join(from, match[1]).split("\\").join("/");
        assert.doesNotThrow(
          () => readFileSync(join(DIST, target)),
          `${file} imports ${match[1]}, absent from dist`,
        );
        walk(target);
      }
    };

    for (const entry of entries) walk(entry);
    assert.ok(seen.has("lib/ranking.js"), "the ranking really is reachable from the service worker");
  });

  it("injects the hook into the MAIN world as early as possible", () => {
    const manifestJson = JSON.parse(lire("manifest.json"));
    const mainWorld = manifestJson.content_scripts.find((c) => c.world === "MAIN");
    assert.ok(mainWorld, "without the MAIN world, window.Worker cannot be replaced");
    assert.equal(mainWorld.run_at, "document_start");
    assert.ok(mainWorld.js.includes("page/hook.js"));

    const isolated = manifestJson.content_scripts.find((c) => c.world !== "MAIN");
    assert.ok(isolated, "without an isolated world there is no chrome.runtime");
  });

  it("replaces the marker with the real preamble", () => {
    const hook = lire("page/hook.js");
    assert.equal(hook.includes("__WORKER_PAYLOAD__"), false);
    assert.ok(hook.includes("createBlocker"));
    assert.doesNotThrow(() => new Function(hook));
  });

  it("carries no commit stamp by default, so dist/ can match itself", () => {
    // `dist/` is committed. A build that always embedded HEAD could never agree
    // with the commit carrying it — the stamp would name that commit's parent —
    // and the check that dist/ is in step with src/ would fail on every push.
    build();
    assert.equal(JSON.parse(lire("manifest.json")).version_name, undefined);
  });

  it("stamps the commit when one is supplied", () => {
    // Release archives are built from a commit that already exists, so their
    // stamp is exact. It is the only copy whose provenance is recorded nowhere
    // else, and the panel shows it.
    process.env.ADS_COMMIT = "deadbee";
    try {
      build();
      const manifestJson = JSON.parse(lire("manifest.json"));
      assert.equal(manifestJson.version_name, `${manifestJson.version} (deadbee)`);
      assert.match(manifestJson.version, /^\d+\.\d+\.\d+$/, "version itself stays numeric");
    } finally {
      delete process.env.ADS_COMMIT;
      build(); // leave dist/ as the repository has it
    }
  });

  it("requests only the permissions it needs", () => {
    const manifestJson = JSON.parse(lire("manifest.json"));
    assert.deepEqual(manifestJson.permissions, ["storage"]);
    // No `host_permissions`: content scripts declare their own `matches`, and
    // the extension issues no request from its own origin.
    assert.equal(manifestJson.host_permissions, undefined);
    for (const script of manifestJson.content_scripts) {
      assert.deepEqual(script.matches, ["*://*.twitch.tv/*"], "never outside Twitch");
    }
  });

  it("writes real PNG files", () => {
    for (const size of [16, 48, 128]) {
      const bytes = readFileSync(join(DIST, `icons/${size}.png`));
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // Width declared in the IHDR chunk.
      assert.equal(bytes.readUInt32BE(16), size);
    }
  });
});
