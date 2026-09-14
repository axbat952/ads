/**
 * Popup formatting. Pure, so it is tested without a browser.
 *
 * The tile set is deliberately short: only what the user can act on. Diagnostic
 * detail — search duration, playlists replaced, fruitless searches — belongs in
 * the log, not on the main screen.
 */

export const COLOURS = {
  background: "#0e0e10",
  card: "#18181b",
  border: "#2f2f35",
  text: "#efeff1",
  muted: "#adadb8",
  accent: "#9147ff",
  green: "#00b686",
  orange: "#f5a623",
  red: "#eb0400",
};

/** Readable duration: "1h 04", "12 min", "45s". */
export function formatDuration(seconds) {
  const total = Math.floor(Math.max(0, Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Current status as {title, detail, colour}.
 *
 * The title answers one question: is there an ad right now, and what is being
 * done about it?
 */
export function status(stats) {
  if (stats.blocking === false) {
    return {
      title: "Monitoring only",
      detail: "Blocking is off — ads play normally.",
      colour: COLOURS.muted,
    };
  }
  if (stats.inBreak && stats.adNotBlocked) {
    return {
      title: "Ad running — hidden",
      detail:
        "No ad-free stream exists for this channel, and the whole playlist is ads: " +
        "removing it would show the streamer's offline screen. The player is covered " +
        "and muted instead, so the ad is neither seen nor heard. A reload is attempted " +
        "in parallel; the live stream returns on its own.",
      colour: COLOURS.orange,
    };
  }
  if (stats.frozenFor) {
    return {
      title: "Ad running — picture frozen",
      detail:
        "No ad-free stream exists for this channel right now. The ad is stripped, so " +
        "the picture freezes instead of showing it. It resumes when the break ends.",
      colour: COLOURS.red,
    };
  }
  if (stats.inBreak) {
    const feeds = (stats.backupFeeds || []).join(", ");
    return {
      title: "Ad running — replaced",
      detail:
        `You are watching the live stream through an ad-free feed${feeds ? ` (${feeds})` : ""}. ` +
        "The ad is not shown to you.",
      colour: COLOURS.green,
    };
  }
  return {
    title: "No ad",
    detail: "The live stream is playing untouched.",
    colour: COLOURS.green,
  };
}

/** [value, label, note] for each tile, in display order. */
export function tiles(stats) {
  const requested = stats.qualityRequested || "—";
  const servedList = stats.qualityServed || [];
  const served = servedList.length ? servedList.join(", ") : "";

  let quality = requested;
  let qualityNote = "requested by the player";
  if (served && served !== requested) {
    quality = `${requested} → ${served}`;
    qualityNote = "served from the replacement feed";
  } else if (served) {
    qualityNote = "replacement matches the request";
  } else if (stats.frozenFor) {
    qualityNote = "nothing to serve, picture frozen";
  }

  const reloads = stats.reloads || 0;
  const useful = stats.usefulReloads || 0;
  const letThrough = stats.adsLetThrough || 0;

  return [
    [formatDuration(stats.watchedFor || 0), "Watch time", "stream actually playing"],
    [String(stats.breaks || 0), "Ad breaks handled", "detected and acted on"],
    [formatDuration(stats.adTimeAvoided || 0), "Ad time avoided", "cumulated across breaks"],
    [
      String(letThrough),
      "Ads let through",
      letThrough ? "whole playlist was ads — hidden instead" : "none",
    ],
    [quality, "Quality", qualityNote],
    [
      String(reloads),
      "Player reloads",
      reloads ? `${useful} led to a clean feed` : "last resort, none needed",
    ],
  ];
}

/**
 * Countdown for the running break, or null outside one.
 *
 * The duration comes from Twitch's `#EXT-X-DATERANGE`: it is what the ad server
 * announces, not what it will honour. Once the announcement is exceeded we stop
 * counting down and show elapsed time instead — better to promise nothing than
 * to promise wrong.
 */
export function breakCountdown(stats, at = Date.now() / 1000) {
  const brk = stats.currentBreak;
  if (!brk || !brk.startedAt) return null;

  const elapsed = Math.max(0, Math.floor(at - brk.startedAt));
  const duration = Math.round(Number(brk.duration) || 0);
  const spots = brk.spots || 0;
  const kind = brk.roll && brk.roll !== "?" ? brk.roll : "AD BREAK";

  if (!duration) {
    return {
      elapsed,
      duration: 0,
      remaining: null,
      overrun: false,
      fraction: 0,
      text: `${kind} — ${elapsed}s elapsed`,
      detail: "no duration announced",
    };
  }

  const remaining = Math.max(0, Math.ceil(brk.startedAt + duration - at));
  const overrun = remaining === 0 && elapsed > duration;
  return {
    elapsed,
    duration,
    remaining,
    overrun,
    fraction: Math.min(1, elapsed / duration),
    text: overrun
      ? `${kind} — ${elapsed}s elapsed (announced ${duration}s exceeded)`
      : `${kind} — back in ${remaining}s`,
    detail: spots > 1 ? `${spots} spots, ${duration}s announced` : `${duration}s announced`,
  };
}

/** [channel, blocked, letThrough], busiest first. */
export function channelTally(stats) {
  return Object.entries(stats.tally || {})
    .map(([channel, values]) => [channel, values[0] || 0, values[1] || 0])
    .sort((a, b) => b[1] + b[2] - (a[1] + a[2]));
}

/** The last break, in one sentence. */
export function lastBreakLine(stats) {
  const brk = stats.lastBreak;
  if (!brk) return "No ad break yet.";
  const roll = brk.roll || "?";
  const duration = Math.round(brk.duration || 0);
  const spots = brk.spots || 0;
  return `Last break: ${roll}, ${duration}s, ${spots} spot${spots > 1 ? "s" : ""}`;
}
