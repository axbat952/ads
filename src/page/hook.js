/**
 * The part that runs in the page's MAIN world.
 *
 * Four jobs:
 *
 * 1. Hook `Worker` — the player fetches its playlists from a Web Worker built
 *    from a blob. Rebuilding that blob with our code prepended is the only way
 *    to see the playlists go by.
 * 2. Tell the engine which channel is being watched — it is in the address, and
 *    the worker does not always see the master playlist.
 * 3. Look after the picture: reload the player on request, unstick it when it
 *    stops, and hide an ad that cannot be replaced.
 * 4. Obey the off switch, including on the very first line of a page load.
 *
 * The player's own token request is deliberately left untouched. Rewriting its
 * `playerType` from `site` to `popout` is TwitchAdSolutions' default, meant to
 * make breaks rarer at the source. It plays correctly (11 starts out of 11),
 * but no reduction in breaks could be measured: ad frequency on one channel
 * swung from a preroll on 8 starts out of 8 to none on 6 out of 6 within the
 * hour, which swamps any difference between the two. An intervention on the
 * player's own session is not worth making for a benefit that cannot be shown.
 *
 * No credentials ever leave the page. The player's OAuth token was harvested at
 * one point to pass it to the worker: that was both useless (Twitch then serves
 * the same campaign to every `playerType`) and unwise (broadcasting a secret on
 * a same-origin channel). Backup requests are anonymous.
 *
 * This is a classic script, not a module: content scripts cannot use
 * `type="module"`. The worker preamble is injected at build time in place of
 * `WORKER_PAYLOAD`.
 */

(() => {
  "use strict";

  const WORKER_PAYLOAD = "__WORKER_PAYLOAD__";
  const TAG = "[twitch-ads-remove]";

  /** Keeps this page's channel separate from other Twitch tabs. */
  const TOKEN = Math.random().toString(36).slice(2, 10);

  /**
   * Mirror of the off switch, readable synchronously.
   *
   * The authority is `chrome.storage.local`, which this world cannot reach and
   * which is async anyway. By the time the bridge could answer, the player may
   * already have built its worker — so the bridge keeps this copy in the page's
   * own `localStorage`, and the decision to hook is taken here, before anything
   * else runs. Unset means on: a first install blocks.
   */
  const MIRROR_KEY = "twitch-ads-remove-enabled";

  function enabledAtLoad() {
    try {
      return window.localStorage.getItem(MIRROR_KEY) !== "0";
    } catch {
      return true; // storage denied by a site-data setting: behave as installed
    }
  }

  let enabled = enabledAtLoad();
  let hookInstalled = false;

  function toExtension(type, data) {
    window.postMessage({ source: "ads-remove-page", type, ...data }, window.location.origin);
  }

  // -- 1. worker hook -----------------------------------------------------

  /**
   * Read a `blob:` worker's source synchronously.
   *
   * Synchronous because a constructor cannot wait: returning before we have the
   * text would let the player start its original worker without our preamble.
   * This is only acceptable on a blob, which is already in memory — the caller
   * checks that before calling.
   */
  function workerSource(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send();
      return xhr.status === 0 || xhr.status === 200 ? xhr.responseText : "";
    } catch {
      return "";
    }
  }

  function blobWithPreamble(source) {
    // The state travels with the payload. A worker built during the instant the
    // switch is flipped would otherwise start on the default — enabled — and
    // only learn otherwise from a message sent after it had already begun.
    const header =
      `globalThis.__ADS_REMOVE_TOKEN = ${JSON.stringify(TOKEN)};\n` +
      `globalThis.__ADS_REMOVE_ENABLED = ${enabled ? "true" : "false"};\n`;
    return URL.createObjectURL(
      new Blob([`${header}${WORKER_PAYLOAD}\n;\n${source}`], { type: "text/javascript" }),
    );
  }

  const OriginalWorker = window.Worker;

  function hookWorker() {
    if (hookInstalled) return;
    hookInstalled = true;
    window.Worker = class extends OriginalWorker {
      constructor(url, workerOptions) {
        let target = url;

        // Switched off: build the worker exactly as the player asked for it.
        // The subclass cannot be removed once installed — it was put in place
        // before the player existed — so this is where "off" has to be honoured
        // for every worker created from now on, and the player builds new ones
        // constantly: on reload, on channel change, on quality change.
        if (!enabled) {
          super(url, workerOptions);
          return;
        }

        try {
          const text = typeof url === "string" ? url : String(url);
          // Blob URLs only. A synchronous read is free on a blob; on a network
          // URL the same call would block the main thread for a round trip.
          const source = text.startsWith("blob:") ? workerSource(text) : "";
          if (source) {
            target = blobWithPreamble(source);
          } else if (text) {
            // Unreadable source: load the original from our own blob instead.
            const absolute = new URL(text, window.location.href).href;
            target = blobWithPreamble(
              workerOptions && workerOptions.type === "module"
                ? `import(${JSON.stringify(absolute)});`
                : `importScripts(${JSON.stringify(absolute)});`,
            );
          }
        } catch {
          target = url;
        }

        super(target, workerOptions);
        // No `addEventListener` and no `postMessage` on this worker: its message
        // channel belongs to the player, and touching it freezes playback.

        // Our blob holds the whole payload plus Twitch's worker source, and the
        // player builds a worker on every reload and quality change. Released
        // once the worker has surely loaded it — a timer, since there is no
        // event on this worker we may listen to.
        if (target !== url) {
          setTimeout(() => {
            try {
              URL.revokeObjectURL(target);
            } catch {
              /* already gone */
            }
          }, 30000);
        }
      }
    };
  }

  // -- private channel ----------------------------------------------------

  const announcedChannels = new Set();
  let channel = null;

  function openChannel() {
    try {
      channel = new BroadcastChannel(`twitch-ads-remove-${TOKEN}`);
    } catch {
      return;
    }
    channel.addEventListener("message", (event) => {
      const data = event && event.data;
      if (!data || typeof data.key !== "string") return;
      handleWorkerMessage(data);
    });
  }

  function handleWorkerMessage(data) {
    if (data.key === "ADS_Ready") {
      console.info(`${TAG} engine installed in the player worker`);
      toExtension("ready", {});
      announcedChannels.clear();
      // A reload builds a new worker, which knows none of this: say it again.
      // All of it — the channel too. Its memory was set at page load, before
      // any worker existed, and kept every later one from ever hearing it.
      announcedOrder = "";
      announcedChannel = "";
      if (channel) channel.postMessage({ key: "ADS_Enabled", enabled });
      broadcastVisibility(true);
      broadcastChannelName();
      return;
    }
    if (data.key === "ADS_Stats") {
      // The watchdog needs this: a reload during a break buys a fresh preroll
      // and unsticks nothing.
      breakReports.set(data.wid || "w", {
        inBreak: Boolean(data.stats && data.stats.inBreak),
        at: Date.now() / 1000,
      });
      // One line the first time a stream is seen: proof the interception works
      // end to end, without exposing a global object the page could read.
      if (data.stats && data.stats.channel && !announcedChannels.has(data.stats.channel)) {
        announcedChannels.add(data.stats.channel);
        console.info(`${TAG} tracking channel: ${data.stats.channel}`);
      }
      toExtension("stats", { stats: data.stats, wid: data.wid || "w" });
      return;
    }
    if (data.key === "ADS_Event") {
      const event = data.event || {};
      if (event.type === "adLetThrough") {
        console.info(`${TAG} ad cannot be replaced — hiding and muting`);
        hidePlayer(event.duration);
      } else if (event.type === "breakOver" || event.type === "adReplaced") {
        revealPlayer();
      } else if (event.type === "search" && !event.found) {
        console.info(`${TAG} no clean feed: ${(event.attempts || []).map((a) => a.join("=")).join(", ")}`);
      } else if (event.type === "traceFetch") {
        console.info(`${TAG} trace ${event.url}`);
      } else if (event.type === "traceServe") {
        console.info(`${TAG} served#${event.n} ${event.source} ${event.url}
${event.body}`);
      } else if (event.type === "break") {
        console.info(`${TAG} ad break ${event.roll || "?"} ${Math.round(event.duration || 0)}s (${event.spots || 0} spot(s))`);
      } else if (event.type === "swap") {
        const changed = event.wanted && event.served && event.wanted !== event.served;
        console.info(
          `${TAG} feed replaced via ${event.label} (${event.quality}${changed ? ` — asked for ${event.wanted}` : ""})`,
        );
        if (changed) {
          toExtension("event", {
            event: { type: "qualityChanged", wanted: event.wanted, served: event.served },
          });
        }
      } else if (event.type === "slowHold") {
        console.info(
          `${TAG} playlist held ${(event.ms / 1000).toFixed(1)}s` +
            ` (tab ${event.hidden ? "hidden" : "visible"}) — the player was waiting on us`,
        );
      } else if (event.type === "playerStopped") {
        console.info(
          `${TAG} the player stopped asking for playlists ${event.after}s ago` +
            ` (tab ${event.hidden ? "hidden" : "visible"}) — nothing is being held on our side`,
        );
      } else if (event.type === "pollResumed") {
        console.info(`${TAG} the player is asking again, after ${event.after}s`);
      } else if (event.type === "error") {
        console.error(`${TAG} engine error: ${event.message}`);
      }
      toExtension("event", { event });
      return;
    }
    if (data.key === "ADS_Reload") {
      // The engine's own limits die with its worker, and every reload builds a
      // new one: the cap of two per break never held, and a new worker asked
      // again at its first poll. The page outlives them all, so the limits that
      // matter are enforced here. The worker already declines in a hidden tab;
      // this is the same rule, where the reload actually happens.
      const t = Date.now() / 1000;
      while (engineReloads.length && t - engineReloads[0] > ENGINE_RELOAD_WINDOW) engineReloads.shift();
      const why =
        document.visibilityState === "hidden"
          ? "tab hidden"
          : t - lastPageReload < ENGINE_RELOAD_COOLDOWN
            ? "too soon after the last one"
            : engineReloads.length >= ENGINE_RELOAD_MAX
              ? `already ${engineReloads.length} in ${ENGINE_RELOAD_WINDOW / 60} min`
              : "";
      if (why) {
        console.info(`${TAG} reload skipped (${data.reason}): ${why}`);
        toExtension("event", { event: { type: "reloadSkipped", reason: data.reason, why } });
        return;
      }
      engineReloads.push(t);
      lastPageReload = t;
      const how = reloadPlayer();
      // `console.info`, not `warn`: Chrome collects content-script warnings on
      // the extension's Errors page, where a successful reload would look like
      // a failure.
      console.info(`${TAG} reloading player (${data.reason}) -> ${how}`);
      toExtension("event", { event: { type: "reloadPerformed", reason: data.reason, how } });
    }
  }

  /** Reloads asked for by the engine, and the limits the page holds them to. */
  const ENGINE_RELOAD_COOLDOWN = 25;
  const ENGINE_RELOAD_WINDOW = 180;
  const ENGINE_RELOAD_MAX = 2;
  const engineReloads = [];
  /** Last reload of any kind, engine's or watchdog's. */
  let lastPageReload = 0;

  // -- 2. channel being watched, read from the address ---------------------

  /** twitch.tv sections that are not channels. */
  const NOT_A_CHANNEL = new Set([
    "", "directory", "videos", "settings", "wallet", "subscriptions", "inventory",
    "drops", "friends", "following", "downloads", "search", "u", "moderator",
    "popout", "team", "jobs", "turbo", "prime", "store", "p",
  ]);

  function channelFromAddress() {
    const first = window.location.pathname.split("/").filter(Boolean)[0] || "";
    const name = first.toLowerCase();
    return NOT_A_CHANNEL.has(name) ? "" : name;
  }

  let announcedChannel = "";
  function broadcastChannelName() {
    const name = channelFromAddress();
    if (!channel || !name || name === announcedChannel) return;
    announcedChannel = name;
    channel.postMessage({ key: "ADS_Channel", channel: name });
  }

  /**
   * Tell the worker whether the tab is in the background.
   *
   * A worker has no `document`, and the difference matters: a freeze that
   * happens only when hidden is a different problem from one that happens
   * anywhere. It is re-sent on every change and to every new worker.
   */
  let announcedHidden = null;
  function broadcastVisibility(force = false) {
    const now = document.visibilityState === "hidden";
    if (!channel || (now === announcedHidden && !force)) return;
    announcedHidden = now;
    channel.postMessage({ key: "ADS_Visible", hidden: now });
  }

  function watchVisibility() {
    document.addEventListener("visibilitychange", () => broadcastVisibility());
  }

  /**
   * Twitch is a single-page application: moving between channels reloads
   * nothing, so address changes are watched. Otherwise the engine would stay on
   * the previous channel.
   */
  function watchAddress() {
    let watching = channelFromAddress();
    const changed = () => {
      announcedChannel = "";
      broadcastChannelName();
      // Another channel is another player: whatever the last one was doing
      // says nothing about this one.
      const now = channelFromAddress();
      if (now !== watching) {
        watching = now;
        resetStall();
      }
    };
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function (...args) {
        const out = original.apply(this, args);
        changed();
        return out;
      };
    }
    window.addEventListener("popstate", changed);
  }

  // -- 3. player reload ---------------------------------------------------

  function findReactNode(root, matches, depth = 0) {
    if (!root || depth > 400) return null;
    try {
      if (root.stateNode && matches(root.stateNode)) return root.stateNode;
    } catch {
      /* some stateNodes throw on read */
    }
    let child = root.child;
    while (child) {
      const found = findReactNode(child, matches, depth + 1);
      if (found) return found;
      child = child.sibling;
    }
    return null;
  }

  function reactRoot() {
    const elements = document.querySelectorAll(
      '#root, [data-a-target="video-player"], .video-player, main',
    );
    for (const element of elements) {
      for (const key of Object.keys(element)) {
        if (key.startsWith("__reactContainer$")) return element[key];
        if (key === "_reactRootContainer") {
          const internal = element[key]._internalRoot || element[key];
          return internal.current || internal;
        }
      }
    }
    return null;
  }

  /**
   * The Twitch player's own media-player instance.
   *
   * Found the way TwitchAdSolutions finds it: the component carrying
   * `setPlayerActive` holds it in `props.mediaPlayerInstance`, sometimes one
   * level down in `playerInstance`.
   */
  function mediaPlayer() {
    try {
      const root = reactRoot();
      if (!root) return null;
      const holder = findReactNode(
        root,
        (n) => n && typeof n.setPlayerActive === "function" && n.props && n.props.mediaPlayerInstance,
      );
      let player = holder ? holder.props.mediaPlayerInstance : null;
      if (player && player.playerInstance) player = player.playerInstance;
      return player && typeof player.play === "function" ? player : null;
    } catch {
      return null;
    }
  }

  /**
   * Pause then play: the cheap remedy, tried before any reload.
   *
   * It makes the player drop its position and resynchronise on the live edge,
   * without a new playback session — so no new access token, and no preroll.
   * TwitchAdSolutions ships this as its default fix for exactly the freeze a
   * playlist swap causes, and documents that it "often fixes" it. A reload is
   * heavier on every count: it costs a preroll, and in a hidden tab the new
   * player cannot even start.
   */
  function nudgePlayer() {
    const player = mediaPlayer();
    if (player) {
      try {
        player.pause();
        player.play();
        return "player:pause-play";
      } catch {
        /* fall through to the element */
      }
    }
    const video = currentVideo();
    if (video) {
      try {
        video.pause();
        const playing = video.play();
        if (playing && typeof playing.catch === "function") playing.catch(() => {});
        return "video:pause-play";
      } catch {
        /* nothing more to try */
      }
    }
    return "none";
  }

  /**
   * Start a new playback session.
   *
   * `setSrc({isNewMediaPlayerInstance: true})` is the Twitch player's own
   * method: it requests a fresh access token and rebuilds the instance, exactly
   * as the player does when you switch channel.
   */
  function reloadPlayer() {
    try {
      const root = reactRoot();
      if (root) {
        const playerState = findReactNode(root, (n) => n && typeof n.setSrc === "function");
        if (playerState) {
          playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
          // And ask it to play. `setSrc` builds a new player that is not
          // necessarily told to start, which is how a reload in a hidden tab
          // left one asking for a playlist once a minute. TwitchAdSolutions
          // calls `play()` straight after the same call.
          const player = mediaPlayer();
          if (player) {
            try {
              player.play();
            } catch {
              /* the player may not be ready yet; it will start on its own */
            }
          }
          return "react:setSrc";
        }
        const player = findReactNode(
          root,
          (n) => n && n.props && n.props.mediaPlayerInstance && typeof n.setPlayerActive === "function",
        );
        if (player) {
          player.setPlayerActive(false);
          player.setPlayerActive(true);
          return "react:setPlayerActive";
        }
      }
    } catch (error) {
      console.info(`${TAG} React reload unavailable:`, error);
    }

    // Fallback: does not request a new token, but unsticks a frozen picture.
    const video = currentVideo();
    if (video) {
      try {
        video.currentTime = video.currentTime; // eslint-disable-line no-self-assign
        const playing = video.play();
        if (playing && typeof playing.catch === "function") playing.catch(() => {});
        return "video:seek";
      } catch {
        /* nothing more to try */
      }
    }
    return "none";
  }

  // -- 4. hiding an ad that cannot be replaced ----------------------------

  /**
   * Last resort when no clean feed exists.
   *
   * Under SSAI the live content is not broadcast during the break, so it cannot
   * be restored. The ad can, however, be neither seen nor heard: cover the
   * player and mute it until the break ends. That is what makes behaviour
   * uniform across channels, including those where nothing is replaceable.
   */
  const OVERLAY_ID = "twitch-ads-remove-overlay";
  const OVERLAY_MAX_S = 120;
  let overlayUntil = 0;
  let overlayTimer = null;
  let mutedBefore = null;
  /** Elements muted for the current ad, so each is given its sound back. */
  const mutedVideos = new Set();

  function playerContainer() {
    return (
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector(".video-player") ||
      (currentVideo() || {}).parentElement ||
      null
    );
  }

  function hidePlayer(durationSeconds) {
    const container = playerContainer();
    if (!container) return;

    // A player reload rebuilds the DOM, orphaning an overlay placed earlier, so
    // it is re-created on every event rather than assumed to still be there.
    const duration = Math.min(Math.max(Number(durationSeconds) || 30, 5), OVERLAY_MAX_S);
    overlayUntil = Date.now() / 1000 + duration + 5;

    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("style", [
        "position:absolute",
        "inset:0",
        "z-index:9",
        "background:#0e0e10",
        "color:#efeff1",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:6px",
        "font:500 15px/1.4 Inter,-apple-system,'Segoe UI',Roboto,sans-serif",
        "pointer-events:none",
      ].join(";"));

      const title = document.createElement("div");
      title.textContent = "Ad hidden";
      const countdown = document.createElement("div");
      countdown.id = `${OVERLAY_ID}-countdown`;
      countdown.setAttribute("style", "color:#adadb8;font-size:12.5px");
      overlay.append(title, countdown);

      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      container.appendChild(overlay);
    }

    // The player's own element — `querySelector` returns a sidebar preview —
    // and on every call: an engine reload right after the ad was let through
    // builds a new element, which would otherwise play the ad aloud.
    const video = currentVideo();
    if (video) {
      if (mutedBefore === null) mutedBefore = video.muted;
      video.muted = true;
      mutedVideos.add(video);
    }

    if (overlayTimer) clearInterval(overlayTimer);
    overlayTimer = setInterval(() => {
      const left = Math.ceil(overlayUntil - Date.now() / 1000);
      const line = document.getElementById(`${OVERLAY_ID}-countdown`);
      if (line) line.textContent = left > 0 ? `live returns in ${left}s` : "resuming…";
      // Safety net: an overlay stuck on screen would be far worse than the ad.
      if (left <= 0) revealPlayer();
    }, 500);
  }

  function revealPlayer() {
    if (overlayTimer) {
      clearInterval(overlayTimer);
      overlayTimer = null;
    }
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    if (mutedBefore !== null) {
      const video = currentVideo();
      if (video) mutedVideos.add(video);
      for (const element of mutedVideos) {
        if (element.isConnected) element.muted = mutedBefore;
      }
    }
    mutedVideos.clear();
    mutedBefore = null;
  }

  // -- 5. watching the picture ---------------------------------------------

  /**
   * Watch whether the picture is ADVANCING — not whether the browser is
   * complaining.
   *
   * The first version listened for `waiting` and `stalled` and missed a twenty
   * minute freeze entirely. When the player gives up completely it does not
   * starve, it dies: the worker stops, the media events stop, and in the end
   * the `<video>` element itself is gone. There is nothing left to fire an
   * event, and a watchdog waiting for one waits for ever.
   *
   * `currentTime` moving is the only signal that means the user is seeing
   * something. It is read from `timeupdate`, which the browser fires several
   * times a second while a picture plays and not at all when it does not — so
   * silence is itself the measurement, and no timer is needed to observe it.
   *
   * The tick only has to notice that silence. Chrome throttles it to once a
   * minute in a page hidden for a while, which is late for a twelve second
   * stall and irrelevant for a twenty minute one.
   */
  const STALL_SECONDS = 25;
  const STALL_RELOAD_COOLDOWN = 60;

  /**
   * First remedy, and a cheap one: pause/play after this long.
   *
   * Early, because it costs nothing — no new session, no preroll — and it can
   * be used in a hidden tab, where a reload cannot. The reload stays in reserve
   * for a picture still stuck at `STALL_SECONDS`, and only in a visible tab.
   */
  const STALL_NUDGE_SECONDS = 6;

  /** Reloads allowed for one stall. Past that, the watchdog waits for progress. */
  const STALL_RELOAD_MAX = 2;

  /**
   * Seconds a tab must have been visible before a reload.
   *
   * Chrome holds back the media of a tab in the background and starts it when
   * the tab is shown. Reloading on that very instant replaced a player that was
   * about to start with one that had to begin again — and buy a preroll.
   */
  const VISIBLE_GRACE = 5;

  let lastAdvance = 0;
  let lastSeenTime = -1;
  /** The element `lastSeenTime` was read from. */
  let watchedVideo = null;
  /**
   * Whether the picture has been seen moving since the page or the channel
   * changed. Until it has, there is no stall to speak of: a channel offline, a
   * page with no player, a tab opened in the background and not yet started.
   * Starting the clock without this reloaded those pages every minute.
   */
  let armed = false;
  let lastStallReload = 0;
  let reloadsThisStall = 0;
  let visibleSince = document.visibilityState === "hidden" ? 0 : Date.now() / 1000;
  let stallAnnounced = false;
  /** Remedies already tried on the current stall, so each is tried once. */
  let nudgedThisStall = false;
  let lastRemedy = "";
  /** When we last paused the player ourselves, and how long that lasts. */
  let nudgedAt = 0;
  const NUDGE_GRACE = 3;
  /**
   * Which workers last said an ad break was running, and when.
   *
   * Per worker, not one flag: every worker on the page reports, and a single
   * value was overwritten by whichever spoke last — an idle one saying "no
   * break" every two seconds let the watchdog reload in the middle of an ad.
   */
  const breakReports = new Map(); // wid -> {inBreak, at}
  const BREAK_REPORT_FRESH = 6;

  function engineInBreak() {
    const t = Date.now() / 1000;
    for (const [wid, report] of breakReports) {
      if (t - report.at > BREAK_REPORT_FRESH * 10) breakReports.delete(wid);
      else if (report.inBreak && t - report.at <= BREAK_REPORT_FRESH) return true;
    }
    return false;
  }

  /**
   * The player's own video element, which is the biggest one on the page.
   *
   * `document.querySelector("video")` returns the FIRST in document order, and
   * a Twitch page has several: the sidebar carries preview players that play on
   * their own. Watching one of those meant `currentTime` was always advancing
   * and the main picture could be frozen for twenty minutes without a word —
   * which is exactly what happened. The previous watchdog survived the same
   * mistake because it listened for events from any element; this one reads a
   * single one, so it has to be the right one.
   */
  function currentVideo() {
    let best = null;
    let bestArea = -1;
    for (const video of document.querySelectorAll("video")) {
      let area = 0;
      try {
        const box = video.getBoundingClientRect();
        area = box.width * box.height;
      } catch {
        area = 0;
      }
      if (area > bestArea) {
        bestArea = area;
        best = video;
      }
    }
    return best;
  }

  /** Is this a channel page, where a picture is supposed to be playing? */
  function shouldBePlaying() {
    return Boolean(channelFromAddress());
  }

  /** Forget the current stall and wait to see the picture move again. */
  function resetStall() {
    armed = false;
    lastAdvance = 0;
    lastSeenTime = -1;
    watchedVideo = null;
    stallAnnounced = false;
    nudgedThisStall = false;
    reloadsThisStall = 0;
    lastRemedy = "";
  }

  /**
   * Note any progress, and return whether the picture is moving.
   *
   * Progress is a change of `currentTime` on the same element between two
   * readings. The first reading of an element is only a reference: a player
   * that was never started reads 0, and taking that for movement started the
   * stall clock on a picture that had not yet had a chance to play.
   */
  function sampleProgress() {
    const video = currentVideo();
    if (!video) return false;
    if (video !== watchedVideo) {
      watchedVideo = video;
      lastSeenTime = video.currentTime;
      return false;
    }
    if (video.currentTime !== lastSeenTime) {
      lastSeenTime = video.currentTime;
      lastAdvance = Date.now() / 1000;
      armed = true;
      return true;
    }
    return false;
  }

  /**
   * A picture paused on purpose is not a picture that stopped. The two are told
   * apart by the data on hand: a deliberate pause leaves a full buffer, a
   * player that has given up has nothing to play.
   */
  function pausedByChoice() {
    // Our own pause/play is not the user's pause. Taken for one, it reset the
    // stall clock: the recovery was then reported as lasting 0s, and the
    // escalation to a reload was pushed back by as long as the nudge had taken.
    if (Date.now() / 1000 - nudgedAt < NUDGE_GRACE) return false;
    const video = currentVideo();
    return Boolean(video) && video.paused && video.readyState >= 3;
  }

  function checkStall() {
    if (!enabled || !shouldBePlaying()) {
      // Off a channel page, the stall clock must not keep running: coming back
      // to a channel ten minutes later found it ten minutes old, and the new
      // player was nudged and reloaded while it was still being built.
      if (armed || watchedVideo) resetStall();
      return;
    }
    // Read before sampling: a picture that moves again resets `lastAdvance`,
    // and measuring after that always reported a recovery of zero seconds.
    const stoppedAt = lastAdvance;
    if (sampleProgress()) {
      if (stallAnnounced || nudgedThisStall) {
        const held = Math.round(Date.now() / 1000 - stoppedAt);
        console.info(`${TAG} picture moving again`);
        toExtension("event", {
          event: {
            type: "pictureRecovered",
            seconds: Math.max(held, 0),
            by: lastRemedy,
            hidden: document.visibilityState === "hidden",
          },
        });
      }
      stallAnnounced = false;
      nudgedThisStall = false;
      reloadsThisStall = 0;
      lastRemedy = "";
      return;
    }
    if (!armed) return; // nothing has played yet: nothing can have stopped
    if (pausedByChoice()) {
      lastAdvance = Date.now() / 1000; // paused on purpose: the clock does not run
      return;
    }

    const stuck = Date.now() / 1000 - lastAdvance;
    if (stuck < STALL_NUDGE_SECONDS) return;

    // 1. Pause/play, once per stall. Allowed in a hidden tab and during a
    //    break: it opens no session, so there is no preroll to buy.
    if (!nudgedThisStall) {
      nudgedThisStall = true;
      nudgedAt = Date.now() / 1000;
      const how = nudgePlayer();
      lastRemedy = "pause/play";
      const hidden = document.visibilityState === "hidden";
      console.info(`${TAG} picture stopped ${Math.round(stuck)}s — pause/play -> ${how}`);
      toExtension("event", {
        event: { type: "playerNudged", seconds: Math.round(stuck), how, hidden },
      });
      return;
    }

    // 2. Still stuck well after that: report it, and reload if we may.
    if (stuck < STALL_SECONDS) return;

    if (!stallAnnounced) {
      stallAnnounced = true;
      const hidden = document.visibilityState === "hidden";
      const videos = document.querySelectorAll("video").length;
      console.info(`${TAG} picture stuck for ${Math.round(stuck)}s (tab ${hidden ? "hidden" : "visible"})`);
      toExtension("event", {
        event: { type: "pictureStuck", seconds: Math.round(stuck), hidden, videos },
      });
    }

    // Never during a break. A reload starts a new playback session, and Twitch
    // greets a new session with a preroll — so reloading through an ad trades a
    // stuck picture for another ad. The engine has its own reload policy for
    // breaks, with a cap per break; this one is for live content.
    if (engineInBreak()) return;

    // Never in a hidden tab either: wait for the user to come back, then act at
    // once. Measured: a reload in a hidden tab took 121 seconds and a second
    // reload to recover, the new player asking for a playlist once a minute in
    // between. Chrome throttles the timers of a hidden page unless it is playing
    // sound, and a reloaded player has not started playing yet — so it gets no
    // exemption and cannot even start. The player it replaced at least had a
    // buffer. Coming back to the tab gives the player `VISIBLE_GRACE` seconds
    // to start on its own; the check then finds the stall already past its
    // threshold and reloads.
    if (document.visibilityState === "hidden") return;

    const t = Date.now() / 1000;
    if (t - visibleSince < VISIBLE_GRACE) return;
    if (t - lastStallReload < STALL_RELOAD_COOLDOWN) return;
    // A player that two reloads did not bring back will not be brought back by
    // a third. Reloading for ever only bought a preroll a minute.
    if (reloadsThisStall >= STALL_RELOAD_MAX) return;
    if (t - lastPageReload < STALL_RELOAD_COOLDOWN) return;
    reloadsThisStall += 1;
    lastStallReload = t;
    lastPageReload = t;
    const how = reloadPlayer();
    lastRemedy = "reload";
    console.info(`${TAG} reloading the player to unstick it -> ${how}`);
    toExtension("event", { event: { type: "reloadPerformed", reason: "picture stuck", how } });
  }

  function watchPicture() {
    // `timeupdate` is the heartbeat: several a second while the picture plays,
    // none at all when it stops. The others are only early warnings.
    //
    // It goes through `checkStall`, never straight to `sampleProgress`. The
    // first heartbeat after a stall is the moment of recovery, and sampling
    // there directly moved the clock forward before the recovery could be
    // measured: every recovery then read as lasting about one second, however
    // long the picture had actually been stopped.
    document.addEventListener("timeupdate", () => checkStall(), true);
    for (const name of ["waiting", "stalled", "pause", "suspend", "emptied", "error", "playing"]) {
      document.addEventListener(name, () => checkStall(), true);
    }
    setInterval(checkStall, 2000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") visibleSince = Date.now() / 1000;
      checkStall();
    });
  }

  // -- 6. the off switch --------------------------------------------------

  /**
   * Apply a switch change to a page that is already open.
   *
   * Switching off takes effect at once: the worker stops reading playlists and
   * any overlay is cleared. Switching back on reaches every worker that was
   * built with the engine in it; one built while the switch was off has none,
   * and only a reload replaces it — which is what the popup says.
   */
  function applySwitch(next) {
    if (next === enabled) return;
    enabled = next;

    if (channel) channel.postMessage({ key: "ADS_Enabled", enabled });
    if (!enabled) revealPlayer();

    console.info(`${TAG} switched ${enabled ? "on" : "off"}`);
  }

  /**
   * Pass the learned order of backup sources down to the worker.
   *
   * It arrives with every telemetry round trip, so it is compared before being
   * forwarded: the order changes a few times an hour at most, and there is no
   * reason to wake the worker twice a second for an identical list.
   */
  let announcedOrder = "";
  function applyRanking(list) {
    const order = Array.isArray(list) ? list.filter((l) => typeof l === "string") : [];
    const signature = order.join("|");
    if (!channel || signature === announcedOrder) return;
    announcedOrder = signature;
    channel.postMessage({ key: "ADS_Ranking", order });
  }

  // -- commands from the extension ----------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "ads-remove-extension") return;
    if (data.type === "setEnabled") applySwitch(data.enabled !== false);
    else if (data.type === "ranking") applyRanking(data.order);
  });

  // The channel stays open even when off, so the switch can be flipped back
  // without reloading, and so a worker that survives the change hears about it.
  openChannel();
  watchAddress();
  watchVisibility();
  watchPicture();

  // Hooked even when switched off: the subclass is a pure pass-through while
  // off. The mirror read above can be stale — it is only written by an open
  // Twitch tab of this origin — and skipping the hook on its word left a whole
  // page unprotected after the switch had been turned back on elsewhere. The
  // bridge corrects `enabled` long before the player builds its worker.
  hookWorker();
  if (!enabled) console.info(`${TAG} switched off — the player is left untouched`);
  broadcastVisibility(true);
  broadcastChannelName();
  if (enabled) console.info(`${TAG} hook installed`);
})();
