# Twitch Ads Remove

A Chrome extension that removes Twitch ads by serving an **ad-free copy of the
same stream** — and hides the ad when no such copy exists.

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

## Switching it off

The panel has an on/off switch. Off is a true pass-through, not a quieter mode:
the engine stops reading playlists, and on the next page load the player's
`Worker` is left alone entirely — the extension may as well not be installed.

Switching off applies to open tabs immediately. Switching back on needs a page
reload, because the player builds its worker once, when the page loads. The
setting persists, so a tab opened later stays off until you turn it back on.

It is there to make the extension easy to rule out: if a stream misbehaves, one
click tells you whether this is the cause.

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
