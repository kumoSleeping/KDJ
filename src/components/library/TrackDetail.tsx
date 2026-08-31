import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Pencil, Plus, RotateCcw, Search, Star, Upload } from "lucide-react";
import { api } from "../../lib/api";
import { DASH, formatBpm, formatBytes, formatDate, formatDuration, isVideoTrack } from "../../lib/format";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import { normalizePriority, normalizeSearchPlatforms } from "../../lib/searchPlatforms";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  consumeSuppressedCoverClick,
  dispatchTrackCoverDrop,
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_COVER_DROP_EVENT,
  TRACK_COVER_DROP_TARGET_ATTR,
  type TrackCoverDropDetail,
} from "../../lib/trackDrag";
import type { Platform, SongSource, Track, TrackPatch } from "../../types";
import { Button, Field, InlineNotice, Panel, PanelStack } from "../common";
import { CoverImage, VinylPlaceholder } from "../common/VinylPlaceholder";
import { CamelotWheel } from "./CamelotWheel";
import { HarmonicList } from "./HarmonicList";
import { useVideoPip } from "../../lib/videoPip";
import { LocalVideoPlayer } from "./LocalVideoPlayer";
import { VjSearchPanel } from "./VjSearchPanel";
import { pointPatch, Waveform } from "./Waveform";
import { EnergyMeter } from "./TrackTable";
import { NowPlayingControlPanel } from "../player/NowPlayingControlPanel";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";
import {
  LocalTrackCacheFacts,
  localDownloadPlatform,
} from "../player/LocalTrackCacheFacts";

/** PlayerBar 播放时广播的位置，用来在节拍网格上画播放头。 */
export const POSITION_EVENT = "kd:position";
export interface PositionDetail {
  trackId: number;
  position: number;
}

/** 后端只收这两种：转码要一整个图像库，而截图是 PNG、网上扒的图是 JPEG，够用了。 */
const COVER_MIME = ["image/jpeg", "image/png"];

/** 标签输入框里认的分隔符。中文逗号和顿号是顺手就会打出来的，别让它们变成标签的一部分。 */
const TAG_SEPARATOR = /[,，、;；\n]/;
type CoverPlatform = Extract<Platform, "wyy" | "qqm">;

interface CoverCandidate {
  source: SongSource;
  platform: CoverPlatform;
  /** 去掉尺寸参数后的地址，用来判断两家返回的是不是同一张图。 */
  coverKey: string;
}

const COVER_PLATFORM_LABEL: Record<CoverPlatform, string> = {
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
function coverPreviewUrl(url: string): string {
  return url.replace(/^http:/i, "https:");
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kd-row" style={{ justifyContent: "space-between", gap: "0.75rem" }}>
      <span className="kd-muted kd-nowrap">{label}</span>
      <span className="kd-muted kd-truncate" style={{ textAlign: "right" }}>
        {children}
      </span>
    </div>
  );
}

/** 采样率 / 来源 / 入库 / 路径——只读事实，挂在 Metadata 面板底部。 */
function FileRows({ track }: { track: Track }) {
  return (
    <>
      <Row label="采样率">
        {track.samplerate ? `${(track.samplerate / 1000).toFixed(1)} kHz` : DASH}
        {track.channels ? ` · ${track.channels}ch` : ""}
      </Row>
      <Row label="来源">{track.source_platform || "local"}</Row>
      <Row label="入库">{formatDate(track.added_at)}</Row>
      <Row label="路径">
        <span className="kd-mono kd-faint" title={track.path}>
          {track.path}
        </span>
      </Row>
    </>
  );
}

/** 表单草稿。标签在编辑期是一行文本，存的时候才切成数组。 */
interface Draft {
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  comment: string;
  tags: string;
}

function toDraft(track: Track): Draft {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    year: track.year,
    comment: track.comment,
    tags: track.tags.join(", "),
  };
}

function splitTags(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(TAG_SEPARATOR)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen].sort();
}

/**
 * 只把**真的改过**的字段放进 patch。
 *
 * 后端那边每个字段的语义是"这次动过没"：原样回传一遍，文件标签就要跟着重写一次，
 * mtime 一变，扫描的增量跳过和别的 DJ 软件的缓存全部作废——用户只是点了一下保存。
 */
function buildPatch(track: Track, draft: Draft): TrackPatch {
  const patch: TrackPatch = {};
  // 显式列出这几个键：`keyof TrackPatch & keyof Draft` 会把 tags 也算进来，
  // 而它在 patch 里是 string[]，在草稿里是一行文本，两边不是同一个东西
  type TextKey = "title" | "artist" | "album" | "genre" | "year" | "comment";
  const text: [TextKey, string, string][] = [
    ["title", draft.title.trim(), track.title],
    ["artist", draft.artist.trim(), track.artist],
    ["album", draft.album.trim(), track.album],
    ["genre", draft.genre.trim(), track.genre],
    ["year", draft.year.trim(), track.year],
    // 备注是给自己看的散文，前后空格不算改动之外的东西，但中间的换行要留着
    ["comment", draft.comment, track.comment],
  ];
  for (const [key, next, current] of text) {
    if (next !== current) patch[key] = next;
  }
  // 用 \u0000 当连接符而不是逗号：标签里可以有逗号，用逗号会把「a,b」这一个标签
  // 和「a」「b」两个标签判成同一串。**必须写成转义**——直接嵌真的 NUL 字节，
  // git 会把整个 .tsx 当二进制，diff 和 grep 就全废了。
  const joined = (list: string[]) => list.join("\u0000");
  const tags = splitTags(draft.tags);
  if (joined(tags) !== joined([...track.tags].sort())) patch.tags = tags;
  return patch;
}

export function TrackDetail({ track }: { track: Track }) {
  const settings = useAppStore((state) => state.settings);
  const detailWaveformVisible = usePlaybackPrefs((state) => state.detailWaveformVisible);
  const detailControlVisible = usePlaybackPrefs((state) => state.detailControlVisible);
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const setCover = useLibraryStore((state) => state.setCover);
  const rereadTags = useLibraryStore((state) => state.rereadTags);
  const selectTrack = useLibraryStore((state) => state.selectTrack);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const keyFilter = useLibraryStore((state) => state.filter.key);
  // 小窗/系统 PiP 已接管这支本地视频时，详情里不再挂第二路解码
  const pipOwnsVideo = useVideoPip(
    (state) =>
      state.active &&
      state.mode !== "panel" &&
      state.session?.source === "local" &&
      state.session.trackId === track.id,
  );

  const [position, setPosition] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(track));
  /** 没封面时后端 404。记下来换成一个可以点的占位块，而不是留一个破图标。 */
  const [hasCover, setHasCover] = useState(true);
  /** 冷读内嵌封面时保留可见反馈，避免把尚未返回误看成“没有封面”。 */
  const [coverLoading, setCoverLoading] = useState(true);
  const [dropping, setDropping] = useState(false);
  /**
   * 这一栏里所有操作（评分 / 保存元数据 / 换封面）的失败原因。
   * 就摆在详情摘要底下——这些操作失败时界面上都是"什么都没发生"，
   * 不说一声用户只会以为按钮点空了。
   */
  const [notice, setNotice] = useState("");
  const [coverSearchBusy, setCoverSearchBusy] = useState(false);
  const [coverCandidates, setCoverCandidates] = useState<CoverCandidate[]>([]);
  const coverInput = useRef<HTMLInputElement>(null);
  const coverBusyRef = useRef(false);
  const coverSearchEpochRef = useRef(0);

  const coverPlatforms = useMemo<CoverPlatform[]>(() => {
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

  // 切曲目时把编辑态整个丢掉。**不跟着 track 的字段变**：
  // 后台分析、WS 推来的 library.updated 都会换掉这个对象，
  // 跟着重置的话用户正在输入的半句话会被一次后台刷新抹掉。
  useEffect(() => {
    setEditing(false);
    setDraft(toDraft(track));
    setPosition(null);
    setNotice("");
    setHasCover(true);
    setCoverLoading(true);
    setCoverSearchBusy(false);
    setCoverCandidates([]);
    coverSearchEpochRef.current += 1;
    // eslint 的 exhaustive-deps 会想要整个 track，那正是上面说的不能要的东西
  }, [track.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPosition = (event: Event) => {
      const detail = (event as CustomEvent<PositionDetail>).detail;
      setPosition(detail.trackId === track.id ? detail.position : null);
    };
    window.addEventListener(POSITION_EVENT, onPosition);
    return () => window.removeEventListener(POSITION_EVENT, onPosition);
  }, [track.id]);

  /**
   * 成功不报喜：
   * 移出曲库连这一栏都没了——做成了的证据本来就在眼前。只有失败要留下来。
   */
  const run = (label: string, action: () => Promise<unknown>) => () => {
    setBusy(true);
    setNotice("");
    action()
      .catch((error: unknown) => setNotice(`${label}失败：${(error as Error).message}`))
      .finally(() => setBusy(false));
  };

  const closeMetadataEditor = () => {
    setEditing(false);
    setCoverCandidates([]);
    setCoverSearchBusy(false);
    coverSearchEpochRef.current += 1;
  };

  const save = run("保存", async () => {
    const patch = buildPatch(track, draft);
    // 一个字都没动就别发请求：后端会照着 patch 重写文件标签
    if (Object.keys(patch).length === 0) {
      closeMetadataEditor();
      return;
    }
    const result = await updateTrack(track.id, patch);
    closeMetadataEditor();
    // 数据库存住了、文件没写进去（只读 / 被 DJ 软件占着）时必须说出来，
    // 否则用户会以为拖进 Rekordbox 的那份也是新的
    if (result.tag_write_error) {
      setNotice(`已存进曲库，但文件标签没写成：${result.tag_write_error}`);
    }
  });

  /** 图片上传和“复用另一首歌的封面”共用一条保存路径，避免两种入口的刷新/报错表现不一致。 */
  const updateCover = useCallback(
    async (load: () => Promise<Blob>, label: string): Promise<boolean> => {
      // 复用封面要先读源图再写目标文件，期间可能跨两个请求；同一目标不能并发写标签。
      if (busy || coverBusyRef.current) return false;
      coverBusyRef.current = true;
      setBusy(true);
      setNotice("");
      try {
        const file = await load();
        await setCover(track.id, file);
        setHasCover(true);
        setCoverLoading(true);
        return true;
      } catch (error: unknown) {
        setNotice(`${label}失败：${(error as Error).message}`);
        return false;
      } finally {
        coverBusyRef.current = false;
        setBusy(false);
      }
    },
    [busy, setCover, track.id],
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
  }, [reuseCover, track.id]);

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

  const selectCoverCandidate = useCallback(
    async (candidate: CoverCandidate) => {
      const ok = await updateCover(
        () => api.onlineCover(candidate.platform, candidate.source.cover),
        "在线封面",
      );
      if (ok) {
        setCoverCandidates([]);
        setNotice(`已采用${COVER_PLATFORM_LABEL[candidate.platform]}封面`);
      }
      return ok;
    },
    [updateCover],
  );

  const searchOnlineCovers = useCallback(async () => {
    if (busy || coverSearchBusy) return;
    if (coverPlatforms.length === 0) {
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

    const epoch = ++coverSearchEpochRef.current;
    setCoverSearchBusy(true);
    setCoverCandidates([]);
    setNotice("");
    try {
      const result = await api.search({
        query,
        platforms: coverPlatforms,
        limit: 6,
        merge: false,
        kind: "song",
      });
      if (epoch !== coverSearchEpochRef.current) return;

      const seen = new Set<string>();
      const candidates: CoverCandidate[] = [];
      for (const platform of coverPlatforms) {
        for (const source of result.per_platform[platform] ?? []) {
          const cover = source.cover.trim();
          if (!cover || source.platform !== platform) continue;
          const coverKey = coverUrlKey(cover);
          if (seen.has(coverKey)) continue;
          seen.add(coverKey);
          candidates.push({ source, platform, coverKey });
          if (candidates.length >= 6) break;
        }
        if (candidates.length >= 6) break;
      }

      if (candidates.length === 0) {
        const errors = Object.values(result.errors).filter(Boolean);
        setNotice(errors[0] ? `没有找到封面：${errors[0]}` : "没有找到可用封面");
        return;
      }
      if (candidates.length === 1) {
        const ok = await selectCoverCandidate(candidates[0]);
        if (!ok && epoch === coverSearchEpochRef.current) setCoverCandidates(candidates);
        return;
      }
      setCoverCandidates(candidates);
      setNotice(`找到 ${candidates.length} 个不同封面，请在下面选择`);
    } catch (error: unknown) {
      if (epoch === coverSearchEpochRef.current) {
        setNotice(`在线匹配失败：${(error as Error).message}`);
      }
    } finally {
      if (epoch === coverSearchEpochRef.current) setCoverSearchBusy(false);
    }
  }, [busy, coverPlatforms, coverSearchBusy, selectCoverCandidate, track.album, track.artist, track.filename, track.title]);

  const openCoverEditor = () => {
    if (consumeSuppressedCoverClick() || busy) return;
    if (!editing) setDraft(toDraft(track));
    setEditing(true);
    // [+] 是入口，不让用户还要在右侧往下找 Metadata；面板顺序仍尊重用户自己的排列。
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '.kd-panel-slot[data-panel-stack="kd-detail-panels"][data-panel-id="metadata"]',
        )
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  const coverDragOver = (event: React.DragEvent<HTMLElement>) => {
    // 图片文件在 WKWebView 的 dragover 阶段不一定暴露 Files MIME；
    // 保持这个框对所有拖入都可放，drop 时再按文件 / 曲目分流。
    event.preventDefault();
    event.stopPropagation();
    if (busy || coverBusyRef.current || coverSearchBusy) {
      setDropping(false);
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };

  const coverDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropping(false);
    }
  };

  const coverDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    if (busy || coverBusyRef.current || coverSearchBusy) return;
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
  const coverUrl = api.coverUrl(track.id, track.modified_at);
  useEffect(() => {
    setHasCover(true);
    setCoverLoading(true);
  }, [coverUrl]);
  const downloadPlatform = localDownloadPlatform(track);
  const fileFactsText = [
    downloadPlatform ? PLATFORM_LABEL[downloadPlatform] : "",
    track.format.toUpperCase() || DASH,
    track.bitrate ? `${track.bitrate} kbps` : "",
    formatDuration(track.duration),
    `文件 ${formatBytes(track.size)}`,
  ].filter(Boolean).join(" ");
  const bpmConfPct =
    track.bpm_confidence !== null ? Math.round(track.bpm_confidence * 100) : null;

  return (
    <div className="kd-col kd-track-detail" style={{ gap: "0.6rem", padding: "0.7rem" }}>
      <div
        className="kd-row kd-track-detail-hero"
        style={{ gap: "0.6rem", alignItems: "flex-start" }}
      >
        <div className="kd-cover-edit-stack">
          <div
            className="kd-cover kd-cover-edit"
          role="button"
          tabIndex={0}
          aria-label="编辑封面"
          title={hasCover ? "点击进入 Metadata 编辑" : "点击 [+] 进入 Metadata 编辑"}
          data-cover-empty={!hasCover ? "true" : undefined}
          data-dropping={dropping ? "true" : undefined}
          data-kd-track-id={track.id}
          {...{ [TRACK_COVER_DROP_TARGET_ATTR]: "true" }}
          style={{
            width: 88,
            height: 88,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            // 拖到位的提示用中性色描边：红色在这个界面里只给"动作"，不给状态
            borderColor: dropping ? "var(--kd-muted)" : undefined,
          }}
          onClick={openCoverEditor}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openCoverEditor();
            }
          }}
          // stopPropagation 是必须的：外层有接收音频文件的拖放区，
          // 不拦住的话拖进来的图片会被当成"要入库的曲目"
          onDragOver={coverDragOver}
          onDragLeave={coverDragLeave}
          onDrop={coverDrop}
        >
          {hasCover ? (
            <>
              {coverLoading ? (
                <span className="kd-cover-loading-placeholder" aria-hidden="true">
                  <VinylPlaceholder />
                </span>
              ) : null}
              <img
                src={coverUrl}
                alt=""
                className="kd-cover-edit-image"
                draggable={false}
                data-loading={coverLoading ? "true" : undefined}
                onLoad={() => setCoverLoading(false)}
                // 没封面时后端返回 404
                onError={() => {
                  setCoverLoading(false);
                  setHasCover(false);
                }}
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
        <input
          ref={coverInput}
          type="file"
          accept="image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={(event) => {
            pickCover(event.target.files?.[0]);
            // 清空 value：连着挑同一个文件两次时 change 不会再触发
            event.target.value = "";
          }}
        />
        <div className="kd-track-detail-summary" style={{ minWidth: 0 }}>
          <div className="kd-truncate" style={{ fontWeight: 700, fontSize: "var(--kd-size-lg)" }}>
            {track.title || track.filename}
          </div>
          <div className="kd-truncate kd-muted">{track.artist || DASH}</div>
          <div className="kd-truncate kd-faint">{track.album || DASH}</div>
          <div
            className="kd-faint kd-track-detail-local-facts"
            style={{ fontSize: "var(--kd-size-xs)" }}
          >
            <div className="kd-track-detail-file-facts" title={fileFactsText}>
              {downloadPlatform ? (
                <PlatformMark id={downloadPlatform} size={13} branded />
              ) : null}
              <span className="kd-track-detail-file-facts-copy">{fileFactsText}</span>
            </div>
            <LocalTrackCacheFacts track={track} />
          </div>
        </div>
      </div>

      <InlineNotice text={notice} onDismiss={() => setNotice("")} />

      {/* 这几块的顺序用户可以拖着调，长期记住——整理曲库时想先看元数据，
          排 set 时想先看接下一首，与其替他选一个，不如让他拖一次然后不用再想。 */}
      <PanelStack
        storageKey="kd-detail-panels"
        defaultFirstIds={["now-playing-control"]}
      >
        {isVideoTrack(track.format) && !pipOwnsVideo && (
          <Panel key="video" heading="Video" padded={false} dense>
            <LocalVideoPlayer track={track} />
          </Panel>
        )}
        {detailControlVisible ? (
          <NowPlayingControlPanel
            key="now-playing-control"
            track={track}
            keyNotation={settings?.key_notation ?? "camelot"}
            filterResonance={settings?.filter_resonance ?? "high"}
            onError={setNotice}
          />
        ) : null}
        <Panel
        key="metadata"
        heading="Metadata"
        padded
        dense
        actions={
          editing ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={closeMetadataEditor}>
                取消
              </Button>
              {/* 编辑器里的并列动作保持中性，避免每次保存都变成整栏的视觉焦点。 */}
              <Button size="sm" disabled={busy} onClick={save}>
                保存
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label="从文件重读标签"
                title="从文件重读标签：库里空着、文件里其实有的时候用"
                disabled={busy}
                onClick={run("重读标签", () => rereadTags(track.id))}
              >
                <RotateCcw size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  // 进编辑态才取一次现值：草稿不跟着后台刷新走，
                  // 所以这里是它唯一和真实数据对齐的时机
                  setDraft(toDraft(track));
                  setEditing(true);
                }}
              >
                <Pencil size={12} />
                编辑
              </Button>
            </>
          )
        }
      >
        {editing ? (
          <div className="kd-col" style={{ gap: "0.4rem" }}>
            <div className="kd-cover-tools">
              <div className="kd-cover-tools-head">
                <span>封面</span>
                <span className="kd-faint">
                  {coverPlatforms.length > 0
                    ? `在线来源：${coverPlatforms.map((platform) => COVER_PLATFORM_LABEL[platform]).join("、")}`
                    : "顶部未开启网易云或 QQ"}
                </span>
              </div>
              <div className="kd-row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || coverSearchBusy}
                  onClick={() => coverInput.current?.click()}
                >
                  <Upload size={12} />
                  上传图片
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || coverSearchBusy || coverPlatforms.length === 0}
                  onClick={() => void searchOnlineCovers()}
                >
                  <Search size={12} />
                  {coverSearchBusy ? "匹配中…" : "在线匹配"}
                </Button>
              </div>
              <div
                className="kd-cover-drop-panel"
                aria-label="封面拖放区域"
                data-dropping={dropping ? "true" : undefined}
                data-kd-track-id={track.id}
                {...{ [TRACK_COVER_DROP_TARGET_ATTR]: "true" }}
                onDragOver={coverDragOver}
                onDragLeave={coverDragLeave}
                onDrop={coverDrop}
              >
                {coverSearchBusy ? (
                  <span className="kd-faint">正在从顶部已打开的平台匹配封面…</span>
                ) : coverCandidates.length > 0 ? (
                  <div className="kd-cover-candidates">
                    {coverCandidates.map((candidate) => (
                      <button
                        key={`${candidate.platform}:${candidate.coverKey}`}
                        type="button"
                        className="kd-cover-candidate"
                        disabled={busy}
                        title="采用这张封面"
                        onClick={() => void selectCoverCandidate(candidate)}
                      >
                        <CoverImage
                          className="kd-cover-candidate-image"
                          src={coverPreviewUrl(candidate.source.cover)}
                          alt=""
                          loading="lazy"
                        />
                        <span className="kd-cover-candidate-copy">
                          <strong>{COVER_PLATFORM_LABEL[candidate.platform]}</strong>
                          <span className="kd-truncate">{candidate.source.title || DASH}</span>
                          <span className="kd-faint kd-truncate">
                            {candidate.source.artists.join(" / ") || DASH}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="kd-faint">把左侧歌曲拖到这里复用封面，或点击上面的在线匹配</span>
                )}
              </div>
            </div>
            <Field label="标题">
              <input
                className="kd-input"
                value={draft.title}
                placeholder={track.filename}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Field>
            <Field label="艺人">
              <input
                className="kd-input"
                value={draft.artist}
                onChange={(event) => setDraft({ ...draft, artist: event.target.value })}
              />
            </Field>
            <Field label="专辑">
              <input
                className="kd-input"
                value={draft.album}
                onChange={(event) => setDraft({ ...draft, album: event.target.value })}
              />
            </Field>
            <div className="kd-row" style={{ gap: "0.4rem", alignItems: "flex-end" }}>
              <Field label="流派" className="kd-grow">
                <input
                  className="kd-input"
                  value={draft.genre}
                  onChange={(event) => setDraft({ ...draft, genre: event.target.value })}
                />
              </Field>
              {/* 年份是文本不是数字输入框：文件里存的可能是 "2021"，
                  也可能是 "2021-05-17"，用 number 会把日期整个吃掉。
                  说明写在 placeholder 里而不是 hint：hint 挂在输入框下面，
                  和左边没有 hint 的「流派」并排时两个输入框会错开一行高。 */}
              <Field label="年份">
                <input
                  className="kd-input"
                  style={{ width: "7.5rem" }}
                  value={draft.year}
                  placeholder="2021-05-17"
                  onChange={(event) => setDraft({ ...draft, year: event.target.value })}
                />
              </Field>
            </div>
            <Field label="标签">
              <input
                className="kd-input"
                value={draft.tags}
                placeholder="逗号分隔：peak time, vocal, 开场"
                onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
              />
            </Field>
            <Field label="备注">
              <textarea
                className="kd-textarea"
                rows={2}
                value={draft.comment}
                placeholder="这首放在哪个段落、和谁接过、要不要练"
                onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
              />
            </Field>
            <span className="kd-field-hint">
              标题 / 艺人 / 专辑 / 流派 / 年份 会一并写回文件标签；标签和备注只存在曲库里。
            </span>
          </div>
        ) : (
          <div className="kd-col" style={{ gap: "0.2rem", fontSize: "var(--kd-size-sm)" }}>
            {/* 标题 / 艺人 / 专辑 上面那块已经显示过了，这里不重复 */}
            <Row label="流派">{track.genre || DASH}</Row>
            <Row label="年份">{track.year || DASH}</Row>
            <div className="kd-row" style={{ gap: "0.25rem", flexWrap: "wrap", marginTop: "0.15rem" }}>
              {track.tags.length ? (
                track.tags.map((tag) => (
                  // 芯片默认全大写，但标签是用户自己敲的原文，"开场" 旁边跟着
                  // 一个被顶成 PEAK TIME 的词只会让人以为自己打错了
                  <span key={tag} className="kd-chip" style={{ textTransform: "none" }}>
                    {tag}
                  </span>
                ))
              ) : (
                <span className="kd-faint">没有标签</span>
              )}
            </div>
            {track.comment && (
              <p className="kd-muted" style={{ marginTop: "0.3rem", whiteSpace: "pre-wrap" }}>
                {track.comment}
              </p>
            )}
            {/* 文件信息并进同一块：单独占一块标题 + 拖动手柄太碎。
                时长/格式/大小上面已显示过，不重复。 */}
            <FileRows track={track} />
          </div>
        )}
        {editing && (
          <div className="kd-col" style={{ gap: "0.2rem", fontSize: "var(--kd-size-sm)" }}>
            <FileRows track={track} />
          </div>
        )}
      </Panel>

      <Panel key="analysis" heading="Analysis" padded dense>
        {/* 调号轮 + 读数同处一面：像一套仪表，而不是圆旁边再挂一个框。 */}
        <div className="kd-analysis-deck">
          <div
            className="kd-analysis-wheel"
            title="亮起的是能和它接上的调；点任意一格按调筛选曲库"
          >
            <CamelotWheel
              code={track.camelot}
              size={128}
              onPick={(code) => setFilter({ key: keyFilter === code ? "" : code })}
            />
            {keyFilter && (
              <button
                type="button"
                className="kd-wheel-filter"
                title="清除调号筛选"
                onClick={() => setFilter({ key: "" })}
              >
                正在筛选 {keyFilter}
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>

          <div className="kd-analysis-readout" aria-label="节奏与响度">
            <div className="kd-analysis-metric">
              <span className="kd-analysis-metric-label">BPM</span>
              <span
                className="kd-analysis-metric-value"
                data-with-version={track.bpm_v3 || track.bpm_v2 || undefined}
              >
                {formatBpm(track.bpm)}
                {track.bpm_v3 ? (
                  <small className="kd-analysis-version">V3</small>
                ) : track.bpm_v2 ? (
                  <small className="kd-analysis-version">V2</small>
                ) : null}
              </span>
              <div
                className="kd-analysis-meter"
                style={
                  bpmConfPct !== null
                    ? ({ "--kd-meter": `${bpmConfPct}%` } as CSSProperties)
                    : undefined
                }
                data-empty={bpmConfPct === null || undefined}
                title={bpmConfPct !== null ? `置信度 ${bpmConfPct}%` : "未分析"}
              >
                <i aria-hidden="true" />
              </div>
              <span className="kd-analysis-metric-hint">
                置信度 {bpmConfPct !== null ? `${bpmConfPct}%` : DASH}
              </span>
            </div>

            <div className="kd-analysis-metric-sep" aria-hidden="true" />

            <div className="kd-analysis-metric">
              <span className="kd-analysis-metric-label">相对响度</span>
              <span className="kd-analysis-metric-value">
                <EnergyMeter value={track.energy} rmsDb={track.rms_db} peakDb={track.peak_db} />
              </span>
              <span className="kd-analysis-metric-hint">
                {track.rms_db !== null ? `${track.rms_db.toFixed(1)} dBFS` : DASH}
                {track.peak_db !== null ? ` · peak ${track.peak_db.toFixed(1)}` : ""}
              </span>
            </div>
          </div>
        </div>

        {/* 波形独占底行。KEY 已由左侧圆图表达，不再重复。 */}
        {detailWaveformVisible ? (
          <Waveform
            trackId={track.id}
            track={track}
            renderProfile="release-overview"
            position={position}
            duration={track.duration ?? 0}
            cueMs={track.cue_ms}
            endMs={track.end_ms}
            height={56}
            onSetPoint={async (kind, at) => {
              const patch = pointPatch(kind, at, track.cue_ms, track.end_ms);
              if (typeof patch === "string") return patch;
              await updateTrack(track.id, patch);
            }}
          />
        ) : null}
        <div className="kd-row kd-faint kd-analysis-meta">
          开始{" "}
          {track.cue_ms !== null ? `${(track.cue_ms / 1000).toFixed(2)}s` : DASH}
          <span className="kd-toolbar-gap" />
          结束{" "}
          {track.end_ms !== null ? `${(track.end_ms / 1000).toFixed(2)}s` : DASH}
          <span className="kd-toolbar-gap" />
          首拍 {track.first_beat !== null ? `${track.first_beat.toFixed(3)}s` : DASH}
          <span className="kd-toolbar-gap" />
          {track.analyzed_at ? `分析于 ${formatDate(track.analyzed_at)}` : "未分析"}
        </div>
        {track.analysis_error && (
          <p style={{ color: "var(--kd-warn)" }}>{track.analysis_error}</p>
        )}
      </Panel>

      <Panel key="harmonic" heading="Next" padded dense>
        {/* 推荐可能有几十首：留在详情栏内滚动，不把后面的面板挤出视野。 */}
        <div className="kd-scroll" style={{ maxHeight: "13rem" }}>
          <HarmonicList track={track} onSelect={selectTrack} />
        </div>
      </Panel>

      <Panel key="vj" heading="Explore" padded dense>
        <VjSearchPanel track={track} />
      </Panel>

      <Panel key="rating" heading="Rating" padded dense>
        {/* 评分不进编辑表单：点一下就是一个完整的意思，没有"改一半反悔"这回事 */}
        <div className="kd-row" style={{ gap: "0.15rem" }}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className="kd-btn kd-btn-icon"
              data-variant="ghost"
              data-size="sm"
              aria-label={`${value} 星`}
              // 再点当前星级 = 清零，不然打错了没法撤
              onClick={() =>
                void updateTrack(track.id, { rating: track.rating === value ? 0 : value }).catch(
                  (error: unknown) => setNotice(`评分失败：${(error as Error).message}`),
                )
              }
            >
              <Star
                size={13}
                fill={value <= track.rating ? "var(--kd-theme)" : "none"}
                color={value <= track.rating ? "var(--kd-theme)" : "currentColor"}
              />
            </button>
          ))}
        </div>
      </Panel>

      </PanelStack>
    </div>
  );
}
