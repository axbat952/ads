/**
 * Builds the loadable extension into `dist/`.
 *
 *     node build.mjs
 *
 * Why a build step at all: the code that runs *inside the player's worker* must
 * be a single text with no `import`, since it is prepended to Twitch's own
 * worker source. The same modules are used as ESM by the tests, so this file
 * flattens them.
 *
 * No dependencies — nothing to install, nothing that breaks on an npm update.
 */

import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

/** One source of truth: the manifest version is the package version. */
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// -- micro bundler ------------------------------------------------------

const IMPORT_RE = /^import\s+\{[\s\S]*?\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(?=(?:const|let|function|async function|class)\b)/gm;
const DECLARATION_RE = /^(?:export\s+)?(?:const|let|(?:async\s+)?function|class)\s+([A-Za-z0-9_$]+)/gm;

/**
 * Flatten an ESM module and its relative dependencies.
 *
 * Deliberately minimal: it only handles the shape used here (named imports,
 * exported declarations). Anything else must fail loudly rather than produce a
 * silently wrong bundle, hence the checks below.
 */
function flatten(entry) {
  const seen = new Set();
  const chunks = [];
  const declarations = new Map();

  function visit(path) {
    const absolute = resolve(path);
    if (seen.has(absolute)) return;
    seen.add(absolute);

    const source = readFileSync(absolute, "utf8");
    for (const dependency of [...source.matchAll(IMPORT_RE)].map((m) => m[1])) {
      if (!dependency.startsWith(".")) {
        throw new Error(`${absolute}: non-relative import "${dependency}" cannot be flattened`);
      }
      visit(resolve(dirname(absolute), dependency));
    }

    const body = source.replace(IMPORT_RE, "").replace(EXPORT_RE, "");
    if (/^\s*(import|export)\b/m.test(body)) {
      throw new Error(`${absolute}: import/export form not supported by the bundler`);
    }

    // Everything ends up in one scope: two declarations of the same name would
    // produce a syntax error far from here.
    for (const match of body.matchAll(DECLARATION_RE)) {
      const name = match[1];
      if (declarations.has(name)) {
        throw new Error(`name collision "${name}" between ${declarations.get(name)} and ${absolute}`);
      }
      declarations.set(name, absolute);
    }

    chunks.push(`/* ${absolute.slice(ROOT.length + 1).replace(/\\/g, "/")} */\n${body.trim()}`);
  }

  visit(entry);
  return chunks.join("\n\n");
}

/** The preamble injected into the player's worker. */
export function workerPayload() {
  const flat = flatten(join(SRC, "worker", "entry.js"));
  // The IIFE is mandatory: our declarations would otherwise share the global
  // scope with Twitch's minified code, whose names are unpredictable.
  const trace = process.env.TRACE ? "globalThis.__ADS_REMOVE_TRACE = true;\n" : "";
  return `(() => {\n"use strict";\n${trace}${flat}\ntry { installHook(self, { enabled: globalThis.__ADS_REMOVE_ENABLED !== false }); } catch (e) { /* not a player worker */ }\n})();`;
}

// -- icons --------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Rounded purple square, generated rather than shipped as a binary asset. */
function iconPng(size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4); // one filter byte per row
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) {
        const at = 1 + x * 4;
        row[at] = 0x91;
        row[at + 1] = 0x47;
        row[at + 2] = 0xff;
        row[at + 3] = 0xff;
      }
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// -- manifest -----------------------------------------------------------

/**
 * Commit stamp for a build meant to be handed out.
 *
 * Off by default, and deliberately so: `dist/` is committed, and a build that
 * embedded `HEAD` could never match itself — the stamp would name the commit
 * before the one carrying it, and the check that `dist/` is in step with `src/`
 * would fail on every push.
 *
 * A release archive is different. It is built from a commit that already
 * exists, so the stamp is exact, and it is the only copy whose provenance is
 * not otherwise recorded anywhere.
 */
function commitStamp() {
  if (process.env.ADS_COMMIT) return process.env.ADS_COMMIT.trim();
  if (!process.argv.includes("--stamp")) return "";
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return ""; // no git, or not a checkout: the version alone will do
  }
}

function manifest() {
  const commit = commitStamp();
  return {
    manifest_version: 3,
    name: "Twitch Ads Remove",
    version: VERSION,
    // Free-form, unlike `version`. Chrome shows it on chrome://extensions and
    // the panel reads it back.
    ...(commit ? { version_name: `${VERSION} (${commit})` } : {}),
    description:
      "Removes Twitch ads by serving an ad-free copy of the same stream, and hides the ad when none exists.",
    // `storage` only. No `host_permissions`: content scripts declare their own
    // matches, and the extension itself never issues a request from its origin.
    permissions: ["storage"],
    background: { service_worker: "background.js", type: "module" },
    action: {
      default_popup: "popup/popup.html",
      default_title: "Twitch Ads Remove",
      default_icon: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" },
    },
    icons: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" },
    content_scripts: [
      {
        // MAIN world: required to replace `window.Worker`, which the player uses
        // to fetch its playlists.
        matches: ["*://*.twitch.tv/*"],
        js: ["page/hook.js"],
        run_at: "document_start",
        world: "MAIN",
        // Kept on: popout and embedded players live in `*.twitch.tv` frames. The
        // matches above already exclude every third-party frame.
        all_frames: true,
      },
      {
        // ISOLATED world: the only place `chrome.runtime` exists.
        matches: ["*://*.twitch.tv/*"],
        js: ["page/bridge.js"],
        run_at: "document_start",
        all_frames: true,
      },
    ],
  };
}

// -- build --------------------------------------------------------------

function write(relative, content) {
  const target = join(DIST, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function copy(relative) {
  write(relative, readFileSync(join(SRC, relative)));
}

export function build() {
  rmSync(DIST, { recursive: true, force: true });

  const payload = workerPayload();
  const hook = readFileSync(join(SRC, "page", "hook.js"), "utf8");
  if (!hook.includes('"__WORKER_PAYLOAD__"')) {
    throw new Error("src/page/hook.js no longer contains the __WORKER_PAYLOAD__ marker");
  }
  write("page/hook.js", hook.replace('"__WORKER_PAYLOAD__"', JSON.stringify(payload)));

  copy("page/bridge.js");
  copy("background.js");
  copy("lib/aggregate.js");
  copy("lib/ranking.js");
  copy("lib/view.js");
  copy("popup/popup.html");
  copy("popup/popup.css");
  copy("popup/popup.js");

  for (const size of [16, 48, 128]) write(`icons/${size}.png`, iconPng(size));

  write("manifest.json", `${JSON.stringify(manifest(), null, 2)}\n`);

  return { payloadBytes: payload.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { payloadBytes } = build();
  console.log(`OK -> ${DIST}`);
  console.log(`worker preamble: ${(payloadBytes / 1024).toFixed(1)} kB`);
}
