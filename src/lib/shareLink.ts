import type { Platform, SongSource, Track } from "../types";
import { version as packageVersion } from "../../package.json";
import { setCoverDragImage } from "./dragPreview";
import type { ShareContentMode } from "./sharePrefs";

type SourceLike = Pick<SongSource, "platform" | "key" | "payload">;
type MatchableSource = SourceLike & Pick<SongSource, "title" | "artists" | "duration">;
type TrackLike = Pick<Track, "source_platform" | "source_key">
  & Partial<Pick<Track, "title" | "filename">>;
type MatchableTrack = Pick<
  Track,
  "title" | "filename" | "artist" | "duration" | "source_platform" | "source_key"
>;

function payloadText(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadIndex(payload: Record<string, unknown> | undefined, key: string): number | null {
  const value = payload?.[key];
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
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
 * 生成平台公开落地页。保留网页回退，同时允许平台移动页唤起已安装的客户端。
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
      if (!/^(?:BV[A-Za-z0-9]+|av\d+)$/i.test(bvid)) return null;
      const link = `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
      const pageIndex = payloadIndex(payload, "page_index");
      const pageCount = payloadIndex(payload, "page_count") ?? 0;
      return pageIndex !== null && (pageIndex > 0 || pageCount > 1)
        ? `${link}?p=${pageIndex + 1}`
        : link;
    }
    default:
      return null;
  }
}

export function songSourceShareLink(source: SourceLike): string | null {
  return platformShareLink(source.platform, source.key, source.payload);
}

export interface ShareSongInfo {
  title?: string | null;
  artists?: string | readonly string[] | null;
  album?: string | null;
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function shareSourceLabel(link: string): string {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "y.music.163.com" || host.endsWith(".music.163.com")) return "网易云音乐";
    if (host === "y.qq.com" || host.endsWith(".y.qq.com")) return "QQ 音乐";
    if (host === "music.youtube.com") return "YouTube Music";
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return "YouTube";
    if (host === "bilibili.com" || host.endsWith(".bilibili.com")) return "哔哩哔哩";
    if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) return "SoundCloud";
  } catch {
    // 链接生成器已经做过校验；这里解析失败时只省略来源，不影响分享。
  }
  return "";
}

/** 生成真正交给剪贴板或外部应用的分享文本。各档主体都保持单行。 */
export function formatShareText(
  link: string,
  info: ShareSongInfo,
  mode: ShareContentMode,
): string {
  const cleanLink = link.trim();
  if (mode === "link_only") return cleanLink;

  const title = oneLine(info.title ?? "");
  const rawArtists = Array.isArray(info.artists) ? info.artists : [info.artists ?? ""];
  const artists = rawArtists.map(oneLine).filter(Boolean).join(", ");
  const album = oneLine(info.album ?? "");
  const heading = title && artists ? `${title} - ${artists}` : title || artists;
  if (mode === "more_info") {
    const source = shareSourceLabel(cleanLink);
    const details = [
      title ? `歌曲：${title}` : "",
      artists ? `艺术家：${artists}` : "",
      album ? `专辑：${album}` : "",
      source ? `来源：${source}` : "",
      `链接：${cleanLink}`,
    ].filter(Boolean);
    return `${details.join(" · ")}\nShare from KDJ v${packageVersion}`;
  }
  return heading ? `${heading} ${cleanLink}` : cleanLink;
}

export interface ShareLinkDragOptions {
  /** 外部应用读取普通文本时拿到的内容；URL MIME 仍始终保留原链接。 */
  plainText?: string;
  /** KDJ 内部拖放已经写入自己的 text/plain 时，不覆盖它。 */
  preservePlainText?: boolean;
}

/**
 * 把公开链接写成系统/浏览器都认识的 URL 拖放载荷。内部 KDJ 拖放需要保留自己的
 * text/plain 后备时只写 text/uri-list；外拖专用时再同时提供普通文本。
 */
export function writeShareLinkDrag(
  dataTransfer: DataTransfer,
  link: string,
  dragSource: Element | null,
  options: ShareLinkDragOptions = {},
): void {
  dataTransfer.effectAllowed = "copyLink";
  dataTransfer.setData("text/uri-list", link);
  if (!options.preservePlainText) {
    dataTransfer.setData("text/plain", options.plainText?.trim() || link);
  }
  setCoverDragImage(dataTransfer, dragSource);
}

/** 优先使用当前选中的来源，不能分享时再尝试这一行的其他在线来源。 */
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

function filenameStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function trackTitleText(track: Partial<Pick<Track, "title" | "filename">>): string {
  return track.title?.trim() || filenameStem(track.filename?.trim() || "").trim();
}

interface BilibiliDownloadedVideoParts {
  parentTitle: string;
  page: number;
}

/** B 站多 P 下载的文件名由 provider 固定写成「总标题 - Pn - 分 P 标题」。 */
function bilibiliDownloadedVideoParts(
  track: Partial<Pick<Track, "title" | "filename">>,
): BilibiliDownloadedVideoParts | null {
  const title = trackTitleText(track);
  const matched = title.match(/^(.*?)\s+-\s+P([1-9]\d*)(?:\s+-\s+.*)?$/i);
  if (!matched) return null;
  const parentTitle = matched[1]?.trim() || "";
  const page = Number.parseInt(matched[2] || "", 10);
  return parentTitle && Number.isSafeInteger(page) ? { parentTitle, page } : null;
}

function withBilibiliPage(link: string, page: number | undefined): string {
  if (!page) return link;
  try {
    const url = new URL(link);
    url.searchParams.set("p", String(page));
    return url.toString();
  } catch {
    return link;
  }
}

/** 下载时保留了平台来源标记的本地文件可以直接生成分享链接。 */
export function trackShareLink(track: TrackLike): string | null {
  const link = platformShareLink(track.source_platform, track.source_key);
  if (!link || track.source_platform.trim().toLowerCase() !== "bilibili") return link;
  return withBilibiliPage(link, bilibiliDownloadedVideoParts(track)?.page);
}

/** 旧版没有保留 BV 号时，用 KDJ 的多 P 命名规则还原原视频搜索词。 */
export function bilibiliVideoShareSearchQuery(
  track: Partial<Pick<Track, "title" | "filename">>,
): string {
  return bilibiliDownloadedVideoParts(track)?.parentTitle || trackTitleText(track);
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

export function trackShareSearchQuery(
  track: Pick<MatchableTrack, "title" | "filename" | "artist">,
): string {
  const title = track.title.trim() || filenameStem(track.filename).trim();
  return [title, track.artist.trim()].filter(Boolean).join(" ");
}

/**
 * 为没有来源标记的本地文件挑选搜索结果。宁可不给链接也不分享错版本：标题必须
 * 相同，已知艺人必须相交，已知时长最多相差八秒。
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

/**
 * 旧版 B 站下载没有把 BV 号带进入库。单 P 仍校验标题、作者和时长；多 P 的本地
 * 时长只代表这一 P，因此改用 KDJ 固定生成的父标题做唯一精确匹配。
 */
export function matchedBilibiliVideoShareLink(
  track: MatchableTrack,
  sources: readonly MatchableSource[],
): string | null {
  const direct = trackShareLink(track);
  if (direct) return direct;

  const multipart = bilibiliDownloadedVideoParts(track);
  const expectedTitle = identityText(multipart?.parentTitle || trackTitleText(track));
  if (!expectedTitle) return null;
  const requestedArtists = artistNames([track.artist]);
  const candidates: Array<{ link: string; durationDelta: number }> = [];

  for (const source of sources) {
    if (source.platform !== "bilibili" || identityText(source.title) !== expectedTitle) continue;
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
    if (!multipart && durationDelta > 8) continue;
    const link = songSourceShareLink(source);
    if (!link) continue;
    candidates.push({
      link: withBilibiliPage(link, multipart?.page),
      durationDelta,
    });
  }

  const unique = [...new Map(candidates.map((candidate) => [candidate.link, candidate])).values()];
  if (multipart && unique.length !== 1) return null;
  unique.sort((left, right) => left.durationDelta - right.durationDelta);
  return unique[0]?.link ?? null;
}
