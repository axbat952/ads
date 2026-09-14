/**
 * Shared test doubles: a cardboard Twitch.
 *
 * The goal is not to imitate Twitch faithfully, but to make the engine's
 * decisions observable: which candidate it keeps, what it serves, and when it
 * asks for a reload.
 */

/** Master playlist with four renditions, one of them HEVC. */
export function master(prefixe, { hevc = true } = {}) {
  const lignes = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=6208173,RESOLUTION=1920x1080,CODECS="avc1.64002A",VIDEO="chunked"',
    `${prefixe}/chunked.m3u8`,
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=3426686,RESOLUTION=1280x720,CODECS="avc1.4D402A",VIDEO="720p60"',
    `${prefixe}/720p60.m3u8`,
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=628660,RESOLUTION=640x360,CODECS="avc1.4D401E",VIDEO="360p30"',
    `${prefixe}/360p30.m3u8`,
  ];
  if (hevc) {
    lignes.push(
      '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked-hevc",NAME="1440p60",AUTOSELECT=NO,DEFAULT=NO',
      '#EXT-X-STREAM-INF:BANDWIDTH=9800000,RESOLUTION=2560x1440,CODECS="hvc1.2.4.L150.B0",VIDEO="chunked-hevc"',
      `${prefixe}/hevc.m3u8`,
    );
  }
  return `${lignes.join("\n")}\n`;
}

/** Media playlist containing live content only. */
export function direct(marque = "a", nombre = 3) {
  const lignes = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:5", "#EXT-X-MEDIA-SEQUENCE:100"];
  for (let i = 0; i < nombre; i += 1) {
    lignes.push("#EXTINF:2.000,live", `https://cdn.example/${marque}-${i}.ts`);
  }
  return `${lignes.join("\n")}\n`;
}

const DATERANGE_PUB =
  '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-09-13T11:16:18.219Z",' +
  'DURATION=30.235,X-TV-TWITCH-AD-ROLL-TYPE="{ROLL}",X-TV-TWITCH-AD-POD-LENGTH="2",' +
  'X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://pub.example/clic"';

/** Midroll: ads *and* live content in the same playlist. */
export function midroll() {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:200",
    DATERANGE_PUB.replace("{ROLL}", "MIDROLL"),
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:2.000,Amazon|1",
    "https://cdn.example/pub-0.ts",
    "#EXTINF:2.000,Amazon|1",
    "https://cdn.example/pub-1.ts",
    "#EXTINF:2.000,live",
    "https://cdn.example/live-0.ts",
    "#EXT-X-TWITCH-PREFETCH:https://cdn.example/prefetch.ts",
    "",
  ].join("\n");
}

/** Preroll: ads only. Stripping would leave the playlist empty. */
export function preroll() {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:0",
    DATERANGE_PUB.replace("{ROLL}", "PREROLL"),
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:2.000,Amazon|1",
    "https://cdn.example/pub-0.ts",
    "#EXTINF:2.000,Amazon|1",
    "https://cdn.example/pub-1.ts",
    "",
  ].join("\n");
}

/**
 * The `playerType` is encoded in the signature.
 *
 * Candidates are issued in parallel, so relying on call order to decide who to
 * answer would make the test lie. The signature travels all the way to the
 * usher URL, so it identifies the candidate unambiguously.
 */
export function tokenResponse(playerType) {
  return JSON.stringify({
    data: {
      streamPlaybackAccessToken: { value: '{"channel":"test"}', signature: `sig-${playerType}` },
    },
  });
}

/** Extract the playerType from a GQL request body. */
export function playerTypeOf(body) {
  try {
    return JSON.parse(body).variables.playerType;
  } catch {
    return "";
  }
}

/**
 * Test fetcher.
 *
 * @param {object} options
 * @param {string[]} options.clean playerTypes whose feed carries no ads
 * @param {string}   options.cleanBody playlist returned by a clean feed
 * @param {string}   options.dirtyBody playlist returned by a feed caught by ads
 */
export function fetcher({ clean = [], cleanBody = direct("clean"), dirtyBody = preroll() } = {}) {
  const calls = [];
  const fonction = async (method, url, headers, body) => {
    calls.push({ method, url, body });

    if (url.includes("gql.twitch.tv")) {
      return { status: 200, text: tokenResponse(playerTypeOf(body)) };
    }
    if (url.includes("usher.ttvnw.net")) {
      const type = (new URL(url).searchParams.get("sig") || "").replace("sig-", "");
      return { status: 200, text: master(`https://backup.example/${type}`) };
    }
    if (url.includes("backup.example")) {
      const type = url.split("/")[3];
      return { status: 200, text: clean.includes(type) ? cleanBody : dirtyBody };
    }
    return { status: 404, text: "" };
  };
  fonction.calls = calls;
  return fonction;
}

/** Driven clock: `clock.t += 30` moves the engine's time forward. */
export function clock(depart = 1000) {
  const etat = { t: depart };
  etat.now = () => etat.t;
  return etat;
}
