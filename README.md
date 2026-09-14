# Twitch Ads Remove

A Chrome extension that removes Twitch ads by serving an **ad-free copy of the
same stream** — and hides the ad when no such copy exists.

No proxy, no certificate, no system configuration. Load it and watch.

---

## How it works

Twitch uses server-side ad insertion (SSAI): ads are stitched into the very same
HLS stream as the live content. There is no separate ad request to block, and
during a break the live content **is not broadcast at all** — so stripping the ad
segments restores nothing.

What does work is asking Twitch for *another feed of the same stream*, issued for
a different `playerType`. Those feeds are usually not stitched. The extension:

1. hooks the player's Web Worker, where playlists are actually fetched;
2. on each media playlist, detects a break from the segment titles and the
   `#EXT-X-DATERANGE` markers;
3. fetches an ad-free feed for one of nine alternative `playerType` values, in
   parallel, and serves it in place of the ad — matching the rendition the player
   asked for, and flagging the timeline change;
4. if every candidate is stitched too, it reloads the player to give Twitch
   another chance, and covers and mutes the player meanwhile.

The result is uniform: either the ad is replaced by the live stream, or it is
hidden. It is never watched.

### What it cannot do

If Twitch stitches every rendition at the same moment, the live content does not
exist anywhere to be served. You get the hidden-ad screen for the length of the
break, not the stream. That is a property of SSAI, not a bug.

## Install

```bash
node build.mjs
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → pick the `dist` folder.

`dist/` is committed, so you can skip the build if you have not changed anything.

Requires Node 22 or later to build and to run the tests. There are no runtime
dependencies and no third-party libraries.

## What you see

The toolbar badge shows a countdown while an ad break is running, and the number
of breaks handled otherwise. Clicking it opens a panel with watch time, ad time
avoided, quality served, and a **per-channel tally** of breaks blocked versus let
through — the number that tells you whether the tool is earning its place on the
channels you actually watch.

Stats persist across browser restarts.

## Tests

```bash
node --test tests/*.test.mjs
```

125 offline tests, no network and no browser: HLS parsing against real captured
playlists (including a real ad break), the decision engine, telemetry
aggregation, the popup formatting, and the build output.

They are not enough on their own. Two significant bugs slipped through because
the tests described an imagined Twitch rather than the real one — obsolete
playlist paths, and a message that froze the player. Hence a smoke test that
loads the extension into a real Chrome on a real stream:

```bash
node tests/smoke.mjs https://www.twitch.tv/some_channel 90
```

It checks the four links of the chain (hook injected, `Worker` replaced, player
worker hooked, playlists intercepted) and counts breaks, replacements and
reloads. `CONTROL=1` replays the same scenario **without** the extension, to tell
a broken tool apart from a page that simply will not start.

To see which `playerType` values currently return an unstitched feed:

```bash
node tests/probe-candidates.mjs some_channel another_channel
```

## Layout

```
src/lib/hls.js        HLS parsing, ad detection, segment stripping (pure)
src/lib/stream.js     obtaining an ad-free feed via an alternative playerType (pure)
src/lib/blocker.js    decision engine: swap, strip, or let through and hide (pure)
src/lib/aggregate.js  telemetry across player workers, surviving reloads (pure)
src/lib/view.js       popup formatting (pure)
src/worker/entry.js   fetch interception inside the player's worker
src/page/hook.js      MAIN-world hook: Worker, player reload, ad overlay
src/page/bridge.js    ISOLATED-world relay to the extension
src/background.js     service worker: session totals, badge, persistence
build.mjs             dependency-free build: bundle, manifest, icons
tests/                offline tests, smoke test, candidate probe
```

Every module under `src/lib` is pure: all I/O goes through injected functions.
That is what makes the engine testable without a network or a browser.

## Privacy

The extension requests one permission, `storage`, and runs only on
`*.twitch.tv`. It never reads, stores or transmits your credentials: backup
requests are anonymous by construction, carrying nothing beyond the public
player Client-ID.

That is not only a privacy choice — it works better. Measured on one channel, at
the same instant, on the same preroll: with identity headers attached, eleven
candidates out of eleven came back stitched; without them, a clean feed was
found. Twitch ties the request to the same viewer and serves the same campaign
everywhere, whereas a backup feed exists precisely to look like a different
viewer.

## Notes

This is a personal project, published in case it is useful. Twitch changes these
internals regularly: the persisted GraphQL query hash, the playlist paths and the
set of usable `playerType` values are all moving targets, and any of them can
break the extension without warning.
