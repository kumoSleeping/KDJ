import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import { normalizePriority, normalizeSearchPlatforms } from "../../lib/searchPlatforms";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  dispatchTrackCoverDrop,
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_COVER_DROP_EVENT,
  TRACK_COVER_DROP_TARGET_ATTR,
  type TrackCoverDropDetail,
} from "../../lib/trackDrag";
import type { Platform, SongSource, Track } from "../../types";
import { VinylPlaceholder } from "../common/VinylPlaceholder";

/** 后端只收这两种：转码要一整个图像库，而截图是 PNG、网上扒的图是 JPEG，够用了。 */
const COVER_MIME = ["image/jpeg", "image/png"];

export type CoverPlatform = Extract<Platform, "wyy" | "qqm">;

export interface CoverCandidate {
  source: SongSource;
  platform: CoverPlatform;
  /** 去掉尺寸参数后的地址，用来判断两家返回的是不是同一张图。 */
  coverKey: string;
}

export const COVER_PLATFORM_LABEL: Record<CoverPlatform, string> = {
  wyy: "网易云",
  qqm: "QQ 音乐",
};

function coverUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

/** 搜索结果偶尔给出 http 封面；Tauri CSP 只放行 https 图片，预览时升级协议。 */
export function coverPreviewUrl(url: string): string {
  return url.replace(/^http:/i, "https:");
}

/**
 * Tracks with a tag or cover write in flight. The summary and the editor can show the same
 * track at once, and one file takes one write at a time, so the flag is per track, not per view.
 */
const writing = new Set<number>();
const writingListeners = new Set<() => void>();

function setWriting(id: number, on: boolean): void {
  if (on) writing.add(id);
  else writing.delete(id);
  for (const listener of writingListeners) listener();
}

function subscribeWriting(listener: () => void): () => void {
  writingListeners.add(listener);
  return () => { writingListeners.delete(listener); };
}

export type TrackCoverEdit = ReturnType<typeof useTrackCover>;

/**
 * 一首曲目的封面状态与所有换封面的入口（上传 / 拖图 / 复用另一首 / 在线匹配），
 * 连同这些操作共用的忙碌标记和失败回执。摘要和 Meta 编辑器各用一份。
 */
export function useTrackCover(track: Track, { onUpdated, receivesDrops = true }: {
  onUpdated?(track: Track): void;
  /** 曲目列表拖到封面上的落点事件只认曲目 id；同一首有两个视图时只让一个接。 */
  receivesDrops?: boolean;
} = {}) {
  const settings = useAppStore((state) => state.settings);
  const setCover = useLibraryStore((state) => state.setCover);
  const busy = useSyncExternalStore(subscribeWriting, () => writing.has(track.id), () => false);
  /** 没封面时后端 404。记下来换成一个可以点的占位块，而不是留一个破图标。 */
  const [hasCover, setHasCover] = useState(true);
  /** 冷读内嵌封面时保留可见反馈，避免把尚未返回误看成“没有封面”。 */
  const [coverLoading, setCoverLoading] = useState(true);
  const [dropping, setDropping] = useState(false);
  /**
   * 这一栏里所有操作（评分 / 保存元数据 / 换封面）的失败原因。
   * 这些操作失败时界面上都是"什么都没发生"，不说一声用户只会以为按钮点空了。
   */
  const [notice, setNotice] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const searchEpochRef = useRef(0);

  const platforms = useMemo<CoverPlatform[]>(() => {
    const selected = new Set(
      normalizeSearchPlatforms(settings?.search_platforms).filter((platform) =>
        isPlatformEnabled(settings, platform),
      ),
    );
    return normalizePriority(settings?.platform_priority ?? []).filter(
      (platform): platform is CoverPlatform =>
        (platform === "wyy" || platform === "qqm") && selected.has(platform),
    );
  }, [settings]);

  const resetSearch = useCallback(() => {
    setCandidates([]);
    setSearching(false);
    searchEpochRef.current += 1;
  }, []);

  // 切曲目时把这一首的回执和匹配结果整个丢掉；**不跟着 track 的字段变**。
  useEffect(() => {
    setNotice("");
    setHasCover(true);
    setCoverLoading(true);
    resetSearch();
  }, [track.id, resetSearch]);

  /**
   * 成功不报喜：做成了的证据本来就在眼前。只有失败要留下来。
   */
  const run = (label: string, action: () => Promise<unknown>) => () => {
    const id = track.id;
    if (writing.has(id)) return;
    setWriting(id, true);
    setNotice("");
    action()
      .catch((error: unknown) => setNotice(`${label}失败：${(error as Error).message}`))
      .finally(() => setWriting(id, false));
  };

  /** 图片上传和“复用另一首歌的封面”共用一条保存路径，避免两种入口的刷新/报错表现不一致。 */
  const updateCover = useCallback(
    async (load: () => Promise<Blob>, label: string): Promise<boolean> => {
      // 复用封面要先读源图再写目标文件，期间可能跨两个请求；同一目标不能并发写标签。
      const id = track.id;
      if (writing.has(id)) return false;
      setWriting(id, true);
      setNotice("");
      try {
        const file = await load();
        const updated = await setCover(id, file);
        onUpdated?.(updated);
        // 新封面带着新的 modified_at 到达后由下面的 effect 接手；这里不盖占位——
        // 同一秒内换图时地址不变，图片不会重新加载，占位就再也揭不掉。
        setHasCover(true);
        return true;
      } catch (error: unknown) {
        setNotice(`${label}失败：${(error as Error).message}`);
        return false;
      } finally {
        setWriting(id, false);
      }
    },
    [setCover, track.id, onUpdated],
  );

  const reuseCover = useCallback(
    (sourceId: number) => {
      if (!Number.isFinite(sourceId)) return;
      if (sourceId === track.id) {
        setNotice("不能把这首歌的封面拖给自己");
        return;
      }
      void updateCover(() => api.coverBlob(sourceId), "复用封面");
    },
    [track.id, updateCover],
  );

  useEffect(() => {
    if (!receivesDrops) return;
    const onTrackCoverDrop = (event: Event) => {
      const detail = (event as CustomEvent<TrackCoverDropDetail>).detail;
      if (detail?.targetTrackId !== track.id) return;
      const sourceId =
        detail.ids.find((id) => Number.isFinite(id) && id !== track.id) ??
        detail.ids.find((id) => Number.isFinite(id));
      if (sourceId !== undefined) reuseCover(sourceId);
    };
    window.addEventListener(TRACK_COVER_DROP_EVENT, onTrackCoverDrop);
    return () => window.removeEventListener(TRACK_COVER_DROP_EVENT, onTrackCoverDrop);
  }, [reuseCover, track.id, receivesDrops]);

  const pickCover = (file: File | null | undefined) => {
    if (!file) return;
    // 本地先挡一道：拖张 webp 进来的话，让它在这里说清楚，
    // 比等后端回一句"封面只支持 JPEG / PNG"少一个来回
    if (file.type && !COVER_MIME.includes(file.type)) {
      setNotice(`封面只支持 JPEG / PNG，这张是 ${file.type}`);
      return;
    }
    void updateCover(() => Promise.resolve(file), "换封面");
  };

  const selectCandidate = useCallback(
    async (candidate: CoverCandidate) => {
      const ok = await updateCover(
        () => api.onlineCover(candidate.platform, candidate.source.cover),
        "在线封面",
      );
      if (ok) {
        setCandidates([]);
        setNotice(`已采用${COVER_PLATFORM_LABEL[candidate.platform]}封面`);
      }
      return ok;
    },
    [updateCover],
  );

  const searchOnline = useCallback(async () => {
    if (writing.has(track.id) || searching) return;
    if (platforms.length === 0) {
      setNotice("先在顶部搜索栏打开网易云或 QQ 音乐");
      return;
    }
    const query = [track.title || track.filename, track.artist, track.album]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");
    if (!query) {
      setNotice("这首歌没有可用于匹配的标题");
      return;
    }

    const epoch = ++searchEpochRef.current;
    setSearching(true);
    setCandidates([]);
    setNotice("");
    try {
      const result = await api.search({
        query,
        platforms,
        limit: 6,
        merge: false,
        kind: "song",
      });
      if (epoch !== searchEpochRef.current) return;

      const seen = new Set<string>();
      const found: CoverCandidate[] = [];
      for (const platform of platforms) {
        for (const source of result.per_platform[platform] ?? []) {
          const cover = source.cover.trim();
          if (!cover || source.platform !== platform) continue;
          const coverKey = coverUrlKey(cover);
          if (seen.has(coverKey)) continue;
          seen.add(coverKey);
          found.push({ source, platform, coverKey });
          if (found.length >= 6) break;
        }
        if (found.length >= 6) break;
      }

      if (found.length === 0) {
        const errors = Object.values(result.errors).filter(Boolean);
        setNotice(errors[0] ? `没有找到封面：${errors[0]}` : "没有找到可用封面");
        return;
      }
      if (found.length === 1) {
        const ok = await selectCandidate(found[0]);
        if (!ok && epoch === searchEpochRef.current) setCandidates(found);
        return;
      }
      setCandidates(found);
      setNotice(`找到 ${found.length} 个不同封面，请在下面选择`);
    } catch (error: unknown) {
      if (epoch === searchEpochRef.current) {
        setNotice(`在线匹配失败：${(error as Error).message}`);
      }
    } finally {
      if (epoch === searchEpochRef.current) setSearching(false);
    }
  }, [platforms, searching, selectCandidate, track.album, track.artist, track.filename, track.id, track.title]);

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    // 图片文件在 WKWebView 的 dragover 阶段不一定暴露 Files MIME；
    // 保持这个框对所有拖入都可放，drop 时再按文件 / 曲目分流。
    event.preventDefault();
    event.stopPropagation();
    if (writing.has(track.id) || searching) {
      setDropping(false);
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropping(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    if (writing.has(track.id) || searching) return;
    // 文件优先：trackDrag 在 dragend 后会保留一小段时间，不能把下一次
    // 紧接着拖入的图片误认成曲目。
    const file = event.dataTransfer.files[0];
    if (file) {
      pickCover(file);
      return;
    }
    if (!isTrackDrag(event)) return;
    const ids = readTrackDragIds(event.dataTransfer);
    if (ids.length === 0) return;
    dispatchTrackCoverDrop(ids, track.id);
    finishTrackDrop();
  };

  // 列表、详情与播放器必须共享同一 cache key。modified_at 在换封面后由后端更新，
  // 既能复用已经加载的缩略图，也能在图片变化时可靠失效。
  // 封面格只有几十到一百来像素宽。请求缩略图而不是原图：内嵌封面可能有十几 MB，
  // 原图要读几秒，曲目信息升起的那几秒里一直是占位。
  const coverUrl = api.coverUrl(track.id, track.modified_at, 256);
  /** 当前 <img> 上已经画出来的封面属于哪首曲目。 */
  const coverShownRef = useRef<number | null>(null);
  useEffect(() => {
    // modified_at 在分析完成、保存标签时也会变。同一首曲目换修订时旧图留在原处，新图
    // 加载完直接替换；只有换了曲目、或这首还没有画出过封面，才盖上占位。
    if (coverShownRef.current !== track.id) {
      coverShownRef.current = null;
      setCoverLoading(true);
    }
    setHasCover(true);
  }, [coverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    busy,
    notice,
    setNotice,
    run,
    pickCover,
    platforms,
    searching,
    candidates,
    searchOnline,
    selectCandidate,
    resetSearch,
    hasCover,
    coverLoading,
    coverUrl,
    dropping,
    // stopPropagation 是必须的：外层有接收音频文件的拖放区，
    // 不拦住的话拖进来的图片会被当成"要入库的曲目"
    dropHandlers: { onDragOver, onDragLeave, onDrop },
    onCoverLoad: () => {
      coverShownRef.current = track.id;
      setCoverLoading(false);
    },
    // 没封面时后端返回 404
    onCoverError: () => {
      coverShownRef.current = null;
      setCoverLoading(false);
      setHasCover(false);
    },
  };
}

/** 封面框：一个明确的 [+] 投放点，图片文件和曲目都能拖上来；点下去做什么由宿主定。 */
export function TrackCoverBox({ track, cover, size = 88, droppable = true, label, title, onActivate }: {
  track: Track;
  cover: TrackCoverEdit;
  size?: number;
  droppable?: boolean;
  label: string;
  title: string;
  onActivate(box: HTMLElement): void;
}) {
  const { hasCover, coverLoading, dropping } = cover;
  return (
    <div className="kd-cover-edit-stack" style={{ width: size }}>
      <div
        className="kd-cover kd-cover-edit"
        role="button"
        tabIndex={0}
        aria-label={label}
        title={title}
        data-cover-empty={!hasCover ? "true" : undefined}
        data-dropping={dropping ? "true" : undefined}
        data-kd-track-id={track.id}
        {...{ [TRACK_COVER_DROP_TARGET_ATTR]: droppable ? "true" : undefined }}
        style={{
          width: size,
          height: size,
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          // 拖到位的提示用中性色描边：红色在这个界面里只给"动作"，不给状态
          borderColor: dropping ? "var(--kd-muted)" : undefined,
        }}
        onClick={(event) => onActivate(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate(event.currentTarget);
          }
        }}
        {...(droppable ? cover.dropHandlers : undefined)}
      >
        {hasCover ? (
          <>
            {coverLoading ? (
              <span className="kd-cover-loading-placeholder" aria-hidden="true">
                <VinylPlaceholder />
              </span>
            ) : null}
            <img
              src={cover.coverUrl}
              alt=""
              className="kd-cover-edit-image"
              draggable={false}
              data-loading={coverLoading ? "true" : undefined}
              onLoad={cover.onCoverLoad}
              onError={cover.onCoverError}
            />
          </>
        ) : (
          <VinylPlaceholder />
        )}
        {!hasCover && (
          <span className="kd-cover-plus" aria-hidden="true">
            <Plus size={14} strokeWidth={2.5} />
          </span>
        )}
      </div>
    </div>
  );
}
