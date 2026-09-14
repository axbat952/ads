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
    const header = `globalThis.__ADS_REMOVE_TOKEN = ${JSON.stringify(TOKEN)};\n`;
    return URL.createObjectURL(
      new Blob([`${header}${WORKER_PAYLOAD}\n;\n${source}`], { type: "text/javascript" }),
    );
  }

  const OriginalWorker = window.Worker;

  function hookWorker() {
    window.Worker = class extends OriginalWorker {
      constructor(url, workerOptions) {
        let target = url;

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

  // -- commands from the extension ----------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "ads-remove-extension") return;
    if (data.type === "reload") reloadPlayer();
  });

  openChannel();
  hookWorker();
  watchAddress();
  broadcastChannelName();
  console.info(`${TAG} hook installed`);
})();
