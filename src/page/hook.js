/**
 * The part that runs in the page's MAIN world.
 *
 * Three jobs:
 *
 * 1. Hook `Worker` — the player fetches its playlists from a Web Worker built
 *    from a blob. Rebuilding that blob with our code prepended is the only way
 *    to see the playlists go by.
 * 2. Tell the engine which channel is being watched — it is in the address, and
 *    the worker does not always see the master playlist.
 * 3. Reload the player on request, and hide an ad that cannot be replaced.
 * 4. Obey the off switch, including on the very first line of a page load.
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
      announcedOrder = "";
      if (channel) channel.postMessage({ key: "ADS_Enabled", enabled });
      broadcastVisibility(true);
      broadcastChannelName();
      return;
    }
    if (data.key === "ADS_Stats") {
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
      } else if (event.type === "breakOver") {
        revealPlayer();
      } else if (event.type === "search" && !event.found) {
        console.info(`${TAG} no clean feed: ${(event.attempts || []).map((a) => a.join("=")).join(", ")}`);
      } else if (event.type === "traceFetch") {
        console.info(`${TAG} trace ${event.url}`);
      } else if (event.type === "break") {
        console.info(`${TAG} ad break ${event.roll || "?"} ${Math.round(event.duration || 0)}s (${event.spots || 0} spot(s))`);
      } else if (event.type === "swap") {
        console.info(`${TAG} feed replaced via ${event.label} (${event.quality})`);
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
      const how = reloadPlayer();
      // `console.info`, not `warn`: Chrome collects content-script warnings on
      // the extension's Errors page, where a successful reload would look like
      // a failure.
      console.info(`${TAG} reloading player (${data.reason}) -> ${how}`);
      toExtension("event", { event: { type: "reloadPerformed", reason: data.reason, how } });
    }
  }

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
    const push = history.pushState;
    history.pushState = function (...args) {
      const out = push.apply(this, args);
      announcedChannel = "";
      broadcastChannelName();
      return out;
    };
    window.addEventListener("popstate", () => {
      announcedChannel = "";
      broadcastChannelName();
    });
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
    const video = document.querySelector("video");
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

  function playerContainer() {
    return (
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector(".video-player") ||
      (document.querySelector("video") || {}).parentElement ||
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

    const video = document.querySelector("video");
    if (video && mutedBefore === null) {
      mutedBefore = video.muted;
      video.muted = true;
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
    const video = document.querySelector("video");
    if (video && mutedBefore !== null) video.muted = mutedBefore;
    mutedBefore = null;
  }

  // -- 5. watching the picture ---------------------------------------------

  /**
   * Watch the element the user actually looks at.
   *
   * Every measurement so far lived in the worker, and the worker is exactly
   * what the player tears down when it gives up — so a freeze erased its own
   * evidence. This lives in the page, which survives that, and it listens to
   * the media events the browser fires when a picture starves: `waiting` and
   * `stalled`. Those are not timers, so a throttled background tab does not
   * delay them.
   *
   * It also acts. A stream stuck for this long needs a reload either way; the
   * user was doing it by hand.
   */
  const STALL_SECONDS = 12;
  const STALL_RELOAD_COOLDOWN = 45;

  let stalledSince = 0;
  let lastStallReload = 0;
  let stallAnnounced = false;

  function currentVideo() {
    return document.querySelector("video");
  }

  function pictureMoving() {
    const video = currentVideo();
    return Boolean(video) && !video.paused && video.readyState >= 3;
  }

  function onStarved(what) {
    if (stalledSince) return;
    stalledSince = Date.now() / 1000;
    stallAnnounced = false;
    console.info(`${TAG} picture starved (${what}, tab ${document.visibilityState})`);
  }

  function onFlowing() {
    if (!stalledSince) return;
    const held = Math.round((Date.now() / 1000 - stalledSince) * 10) / 10;
    stalledSince = 0;
    stallAnnounced = false;
    if (held >= 2) {
      console.info(`${TAG} picture recovered after ${held}s`);
      toExtension("event", { event: { type: "pictureRecovered", seconds: held } });
    }
  }

  /**
   * Media events do not bubble, but they do capture — one listener on the
   * document catches them from whatever `<video>` the player has built, and
   * there is no element to re-attach to when it builds a new one.
   */
  function watchPicture() {
    for (const name of ["waiting", "stalled"]) {
      document.addEventListener(name, () => onStarved(name), true);
    }
    for (const name of ["playing", "timeupdate"]) {
      document.addEventListener(name, () => onFlowing(), true);
    }

    setInterval(() => {
      if (!enabled) return;
      if (!stalledSince) {
        // Belt and braces: a picture can stop without either event firing.
        const video = currentVideo();
        if (video && !video.paused && video.readyState < 3) onStarved("readyState");
        return;
      }
      if (pictureMoving()) {
        onFlowing();
        return;
      }

      const stuck = Date.now() / 1000 - stalledSince;
      if (stuck < STALL_SECONDS) return;

      if (!stallAnnounced) {
        stallAnnounced = true;
        const hidden = document.visibilityState === "hidden";
        console.info(`${TAG} picture stuck for ${Math.round(stuck)}s (tab ${hidden ? "hidden" : "visible"})`);
        toExtension("event", {
          event: { type: "pictureStuck", seconds: Math.round(stuck), hidden },
        });
      }

      const t = Date.now() / 1000;
      if (t - lastStallReload < STALL_RELOAD_COOLDOWN) return;
      lastStallReload = t;
      const how = reloadPlayer();
      console.info(`${TAG} reloading the player to unstick it -> ${how}`);
      toExtension("event", { event: { type: "reloadPerformed", reason: "picture stuck", how } });
    }, 2000);
  }

  // -- 6. the off switch --------------------------------------------------

  /**
   * Apply a switch change to a page that is already open.
   *
   * Switching off takes effect at once: the worker stops reading playlists and
   * any overlay is cleared. What cannot be undone live is the `Worker` subclass
   * — it was installed before the player existed, and removing it now would not
   * affect the worker already running. Switching back on therefore needs a
   * reload, which is what the popup says.
   */
  function applySwitch(next) {
    if (next === enabled) return;
    enabled = next;

    if (channel) channel.postMessage({ key: "ADS_Enabled", enabled });
    if (!enabled) revealPlayer();

    if (enabled && !hookInstalled) {
      console.info(`${TAG} switched on — reload the page to hook the player`);
      return;
    }
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
    if (data.type === "reload") reloadPlayer();
    else if (data.type === "setEnabled") applySwitch(data.enabled !== false);
    else if (data.type === "ranking") applyRanking(data.order);
  });

  // The channel stays open even when off, so the switch can be flipped back
  // without reloading, and so a worker that survives the change hears about it.
  openChannel();
  watchAddress();
  watchVisibility();
  watchPicture();

  if (!enabled) {
    console.info(`${TAG} switched off — the player is left untouched`);
    return;
  }

  hookWorker();
  broadcastVisibility(true);
  broadcastChannelName();
  console.info(`${TAG} hook installed`);
})();
