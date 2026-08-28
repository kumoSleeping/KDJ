import type { Platform, SongSource, Track } from "../types";

type SourceLike = Pick<SongSource, "platform" | "key" | "payload">;
type MatchableSource = SourceLike & Pick<SongSource, "title" | "artists" | "duration">;
type TrackLike = Pick<Track, "source_platform" | "source_key">;
type MatchableTrack = Pick<
  Track,
  "title" | "filename" | "artist" | "duration" | "source_platform" | "source_key"
>;

function payloadText(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function safeToken(raw: string): string {
  const value = raw.trim();
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : "";
}

function soundCloudPermalink(raw: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      !["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(host)
    ) {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Build a public HTTPS landing page for a platform item. These links keep a web fallback while
 * allowing each platform's own mobile page to offer/open its installed app.
 */
export function platformShareLink(
  platform: string,
  rawKey: string,
  payload: Record<string, unknown> = {},
): string | null {
  const id = safeToken(rawKey);
  switch (platform.trim().toLowerCase() as Platform) {
    case "wyy":
      return /^\d+$/.test(id) ? `https://y.music.163.com/m/song?id=${id}` : null;
    case "qqm":
      return id ? `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(id)}` : null;
    case "soundcloud":
      return soundCloudPermalink(payloadText(payload, "permalink_url") || rawKey.trim());
    case "ytm": {
      const videoId = safeToken(payloadText(payload, "video_id")) || id;
      return videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
    }
    case "youtube": {
      const videoId = safeToken(payloadText(payload, "video_id")) || id;
      return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
    }
    case "bilibili": {
      const bvid = safeToken(payloadText(payload, "bvid")) || id;
      return /^(?:BV[A-Za-z0-9]+|av\d+)$/i.test(bvid)
        ? `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`
        : null;
    }
    default:
      return null;
  }
}

export function songSourceShareLink(source: SourceLike): string | null {
  return platformShareLink(source.platform, source.key, source.payload);
}

/** Prefer the row's selected source, then fall back to another shareable online source. */
export function firstSourceShareLink(
  sources: readonly SourceLike[],
  preferredIndex = 0,
): string | null {
  const preferred = sources[preferredIndex];
  if (preferred) {
    const link = songSourceShareLink(preferred);
    if (link) return link;
  }
  for (const source of sources) {
    if (source === preferred) continue;
    const link = songSourceShareLink(source);
    if (link) return link;
  }
  return null;
}

/** Local files are immediately shareable when KDJ retained a supported platform source key. */
export function trackShareLink(track: TrackLike): string | null {
  return platformShareLink(track.source_platform, track.source_key);
}

function filenameStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function identityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function artistNames(values: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    for (const part of value.split(/[\/,、;&，；|｜]+/)) {
      const normalized = identityText(part);
      if (normalized && !["unknown", "未知", "未知艺人", "群星"].includes(normalized)) {
        names.add(normalized);
      }
    }
  }
  return names;
}

export function trackShareSearchQuery(track: Pick<MatchableTrack, "title" | "filename" | "artist">): string {
  const title = track.title.trim() || filenameStem(track.filename).trim();
  return [title, track.artist.trim()].filter(Boolean).join(" ");
}

/**
 * Select a search hit for an imported local file. Sharing the wrong version is worse than
 * returning no link, so normalized titles must be equal, known artists must overlap, and known
 * durations may differ by at most eight seconds.
 */
export function matchedTrackShareLink(
  track: MatchableTrack,
  sources: readonly MatchableSource[],
): string | null {
  const direct = trackShareLink(track);
  if (direct) return direct;

  const title = identityText(track.title.trim() || filenameStem(track.filename));
  if (!title) return null;
  const requestedArtists = artistNames([track.artist]);
  const candidates: Array<{ link: string; durationDelta: number; platformRank: number }> = [];

  for (const source of sources) {
    if (identityText(source.title) !== title) continue;
    const candidateArtists = artistNames(source.artists ?? []);
    if (
      requestedArtists.size > 0
      && candidateArtists.size > 0
      && ![...requestedArtists].some((artist) => candidateArtists.has(artist))
    ) {
      continue;
    }
    const durationDelta =
      track.duration != null && source.duration != null
        ? Math.abs(track.duration - source.duration)
        : 4;
    if (durationDelta > 8) continue;
    const link = songSourceShareLink(source);
    if (!link) continue;
    candidates.push({
      link,
      durationDelta,
      platformRank: source.platform === "wyy" ? 0 : source.platform === "qqm" ? 1 : 2,
    });
  }

  candidates.sort(
    (left, right) => left.durationDelta - right.durationDelta || left.platformRank - right.platformRank,
  );
  return candidates[0]?.link ?? null;
}
