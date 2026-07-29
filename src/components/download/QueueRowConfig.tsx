import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link2, Music4, Search } from "lucide-react";
import { api } from "../../lib/api";
import { DASH } from "../../lib/format";
import {
  forgetQueueDraft,
  getQueueDraft,
  patchVideoDraft,
  rememberVideoEnqueue,
  rekeyQueueDraft,
  setQueueDraft,
  subscribeQueueDrafts,
  type OffsetMode,
  type VideoQueueDraft,
} from "../../lib/queueTaskDraft";
import { isTrackDrag, readTrackDragIds, claimActiveTrackDragIds } from "../../lib/trackDrag";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { DownloadTask, Quality, Track, VideoInfo } from "../../types";

const VIDEO_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_QUALITIES: Quality[] = ["flac", "320", "128"];

const infoCache = new Map<string, VideoInfo>();

function useDraft(taskId: string) {
  return useSyncExternalStore(
    subscribeQueueDrafts,
    () => getQueueDraft(taskId),
    () => getQueueDraft(taskId),
  );
}

async function applyVideoDraft(
  task: DownloadTask,
  draft: VideoQueueDraft,
): Promise<string> {
  if (task.state !== "queued") {
    throw new Error("只有排队中的任务还能改参数；已开始的请取消后重新加入");
  }
  const downloads = useDownloadStore.getState();
  await downloads.cancel(task.id);
  forgetQueueDraft(task.id);
  const next = await api.videoDownload(draft.request);
  rememberVideoEnqueue(next.id, draft.request);
  // 保留用户在面板里选好的 Offset 模式 / 绑定曲目
  setQueueDraft(next.id, { ...draft, request: { ...draft.request } });
  downloads.mergeTasks([
    {
      ...next,
      title: draft.request.title?.trim() || task.title || next.title,
      artist: draft.request.artist?.trim() || task.artist || next.artist,
      cover: draft.request.cover?.trim() || task.cover || next.cover,
      dest_dir: draft.request.dest_dir || task.dest_dir,
    },
  ]);
  return next.id;
}

export function QueueRowConfig({
  task,
  open,
  onTaskReplaced,
}: {
  task: DownloadTask;
  open: boolean;
  onTaskReplaced?(nextId: string): void;
}) {
  const draft = useDraft(task.id);
  const settings = useAppStore((state) => state.settings);
  const playerTrack = useLibraryStore(selectSelectedTrack);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [trackQuery, setTrackQuery] = useState("");
  const [trackHits, setTrackHits] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropHot, setDropHot] = useState(false);

  const bvid = draft?.kind === "video" ? draft.request.bvid?.trim() || "" : "";

  // 视频任务第一次点开：若还没有草稿，用当前全局默认补一份（只能改展示，真正生效需重新入队）
  useEffect(() => {
    if (!open || task.kind !== "video" || draft) return;
    const height = Number.parseInt(task.quality, 10);
    const bvidMatch = task.title.match(/\bBV[0-9A-Za-z]{10}\b/);
    rememberVideoEnqueue(task.id, {
      bvid: bvidMatch?.[0],
      page_index: 0,
      max_height: Number.isFinite(height) && height > 0 ? height : (settings?.video_max_height ?? 1080),
      audio_only: task.quality === "audio",
      transcode: true,
      title: task.title,
      artist: task.artist,
      cover: task.cover,
      dest_dir: task.dest_dir,
    });
  }, [open, task, draft, settings?.video_max_height]);

  useEffect(() => {
    if (!open || task.kind !== "video" || !bvid) return;
    const cached = infoCache.get(bvid);
    if (cached) {
      setInfo(cached);
      return;
    }
    let alive = true;
    void api
      .videoResolve(bvid)
      .then((result) => {
        infoCache.set(bvid, result);
        if (alive) setInfo(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, task.kind, bvid]);

  useEffect(() => {
    if (!open || task.kind !== "video") return;
    const q = trackQuery.trim();
    if (q.length < 1) {
      setTrackHits([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .tracks({ q, limit: 8 })
        .then((page) => {
          if (alive) setTrackHits(page.items);
        })
        .catch(() => {
          if (alive) setTrackHits([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, task.kind, trackQuery]);

  const videoDraft = draft?.kind === "video" ? draft : null;
  const pages = info?.pages ?? [];
  const pageIndex = videoDraft?.request.page_index ?? 0;
  const audioOnly = Boolean(videoDraft?.request.audio_only);
  const maxHeight = videoDraft?.request.max_height ?? settings?.video_max_height ?? 1080;
  const offsetMode: OffsetMode = videoDraft?.offsetMode ?? "none";
  const canEdit = task.state === "queued";

  const qualityLabel = useMemo(() => {
    if (task.kind !== "audio") return null;
    const q = (draft?.kind === "audio" ? draft.quality : null) ?? settings?.default_quality ?? "flac";
    return q === "flac" ? "FLAC" : `${q}K`;
  }, [task.kind, draft, settings?.default_quality]);

  if (!open) return null;

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    setError("");
    try {
      const nextId = await work();
      if (typeof nextId === "string" && nextId !== task.id) onTaskReplaced?.(nextId);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const bindTrack = (track: Track) => {
    if (!videoDraft) return;
    patchVideoDraft(task.id, {
      offsetMode: "bound",
      boundTrackId: track.id,
      boundTrackTitle: track.title || track.filename,
      boundTrackArtist: track.artist,
    });
    setTrackQuery("");
    setTrackHits([]);
  };

  if (task.kind === "audio") {
    return (
      <div className="kd-queue-config" onClick={(event) => event.stopPropagation()}>
        <div className="kd-queue-config-row">
          <span className="kd-muted">音质</span>
          <button
            type="button"
            className="kd-cycle-control"
            disabled={!canEdit || Boolean(busy)}
            title={
              canEdit
                ? `本条音质：${qualityLabel}（覆盖全局默认）。点一下切换并重新排队`
                : "已开始的任务不能改音质"
            }
            onClick={() => {
              const current =
                (draft?.kind === "audio" ? draft.quality : null) ??
                settings?.default_quality ??
                "flac";
              const index = AUDIO_QUALITIES.indexOf(current);
              const next =
                AUDIO_QUALITIES[(index + 1 + AUDIO_QUALITIES.length) % AUDIO_QUALITIES.length];
              setQueueDraft(task.id, { kind: "audio", quality: next });
              void run("改音质", async () => {
                // 音频改参：取消后按同来源重入队做不到（任务不带 SongSource）。
                // 先把草稿记上；真正覆盖要等后续后端支持。至少 UI 标明本条意图。
                if (task.state !== "queued") throw new Error("只有排队中的任务还能改");
              });
            }}
          >
            {qualityLabel}
          </button>
          <span className="kd-faint" style={{ fontSize: "var(--kd-size-xs)" }}>
            未单独改则跟随顶部默认
          </span>
        </div>
        {error ? <p className="kd-queue-config-error">{error}</p> : null}
      </div>
    );
  }

  if (task.kind !== "video" || !videoDraft) {
    return (
      <div className="kd-queue-config">
        <p className="kd-muted" style={{ fontSize: "var(--kd-size-xs)", margin: 0 }}>
          这条没有可改的下载参数。
        </p>
      </div>
    );
  }

  if (!bvid) {
    return (
      <div className="kd-queue-config">
        <p className="kd-muted" style={{ fontSize: "var(--kd-size-xs)", margin: 0 }}>
          缺少 BV 号，无法在队列里改分 P / Offset。请从搜索结果重新加入。
        </p>
      </div>
    );
  }

  return (
    <div className="kd-queue-config" onClick={(event) => event.stopPropagation()}>
      <div className="kd-queue-config-row">
        {pages.length > 1 ? (
          <span className="kd-cycle-field">
            <span>分 P</span>
            <button
              type="button"
              className="kd-cycle-control"
              disabled={!canEdit || Boolean(busy)}
              title={`${pages[pageIndex]?.title ?? `P${pageIndex + 1}`} · 点击切换`}
              onClick={() => {
                const nextPage = (pageIndex + 1) % pages.length;
                const next = patchVideoDraft(task.id, { request: { page_index: nextPage } });
                if (!next) return;
                void run("改分 P", () => applyVideoDraft(task, next));
              }}
            >
              P{pageIndex + 1}/{pages.length}
            </button>
          </span>
        ) : null}

        <span className="kd-cycle-field">
          <span>画质</span>
          <button
            type="button"
            className="kd-cycle-control"
            disabled={!canEdit || audioOnly || Boolean(busy)}
            title={`最高 ${maxHeight}p · 点击切换`}
            onClick={() => {
              const index = VIDEO_HEIGHTS.indexOf(maxHeight);
              const nextHeight =
                VIDEO_HEIGHTS[(index + 1 + VIDEO_HEIGHTS.length) % VIDEO_HEIGHTS.length] ?? 1080;
              const next = patchVideoDraft(task.id, { request: { max_height: nextHeight } });
              if (!next) return;
              void run("改画质", () => applyVideoDraft(task, next));
            }}
          >
            {maxHeight}P
          </button>
        </span>

        <label className="kd-check">
          <input
            type="checkbox"
            checked={audioOnly}
            disabled={!canEdit || Boolean(busy)}
            onChange={(event) => {
              const next = patchVideoDraft(task.id, {
                request: { audio_only: event.target.checked },
              });
              if (!next) return;
              void run("改音轨", () => applyVideoDraft(task, next));
            }}
          />
          <Music4 size={12} />
          只要音轨
        </label>
      </div>

      <div className="kd-queue-config-block">
        <div className="kd-queue-config-label">Offset 自动识别下载</div>
        <label className="kd-queue-radio">
          <input
            type="radio"
            name={`offset-${task.id}`}
            checked={offsetMode === "none"}
            disabled={!canEdit || Boolean(busy)}
            onChange={() => {
              const next = patchVideoDraft(task.id, {
                offsetMode: "none",
                request: { offset_ms: 0 },
              });
              if (!next) return;
              void run("清 Offset", () => applyVideoDraft(task, next));
            }}
          />
          <span>不用 Offset（按原片）</span>
        </label>
        <label className="kd-queue-radio">
          <input
            type="radio"
            name={`offset-${task.id}`}
            checked={offsetMode === "player"}
            disabled={!canEdit || Boolean(busy)}
            onChange={() => {
              void run("校准当前播放曲", async () => {
                if (!playerTrack) {
                  throw new Error("请先在播放器里放一首本地曲目");
                }
                const result = await api.videoCalibrate(playerTrack.id, bvid, pageIndex);
                const next = patchVideoDraft(task.id, {
                  offsetMode: "player",
                  boundTrackId: playerTrack.id,
                  boundTrackTitle: playerTrack.title || playerTrack.filename,
                  boundTrackArtist: playerTrack.artist,
                  request: { offset_ms: Math.round(result.offset_ms) },
                });
                if (!next) return;
                await applyVideoDraft(task, next);
              });
            }}
          />
          <span>
            按当前播放器歌曲相同 Offset 自动识别
            {playerTrack ? (
              <span className="kd-faint">
                {" "}
                · {playerTrack.title || playerTrack.filename}
              </span>
            ) : (
              <span className="kd-faint"> · 播放器里还没有本地曲</span>
            )}
          </span>
        </label>
        <label className="kd-queue-radio">
          <input
            type="radio"
            name={`offset-${task.id}`}
            checked={offsetMode === "bound"}
            disabled={!canEdit || Boolean(busy)}
            onChange={() => {
              patchVideoDraft(task.id, { offsetMode: "bound" });
            }}
          />
          <span>绑定一首歌曲的 Offset 下载</span>
        </label>

        {offsetMode === "bound" ? (
          <div className="kd-queue-bind">
            <div
              className="kd-queue-bind-slot"
              data-hot={dropHot || undefined}
              onDragOver={(event) => {
                if (!isTrackDrag(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDropHot(true);
              }}
              onDragLeave={() => setDropHot(false)}
              onDrop={(event) => {
                setDropHot(false);
                const ids = readTrackDragIds(event.dataTransfer);
                const trackIds = ids.length > 0 ? ids : claimActiveTrackDragIds();
                if (!trackIds.length) return;
                event.preventDefault();
                void run("绑定曲目", async () => {
                  const track = await api.track(trackIds[0]);
                  bindTrack(track);
                  const result = await api.videoCalibrate(track.id, bvid, pageIndex);
                  const next = patchVideoDraft(task.id, {
                    offsetMode: "bound",
                    boundTrackId: track.id,
                    boundTrackTitle: track.title || track.filename,
                    boundTrackArtist: track.artist,
                    request: { offset_ms: Math.round(result.offset_ms) },
                  });
                  if (!next) return;
                  await applyVideoDraft(task, next);
                });
              }}
            >
              {videoDraft.boundTrackId ? (
                <span>
                  <Link2 size={12} /> {videoDraft.boundTrackTitle || DASH}
                  {videoDraft.boundTrackArtist ? (
                    <span className="kd-faint"> · {videoDraft.boundTrackArtist}</span>
                  ) : null}
                  {videoDraft.request.offset_ms ? (
                    <span className="kd-mono">
                      {" "}
                      · {videoDraft.request.offset_ms > 0 ? "+" : ""}
                      {(videoDraft.request.offset_ms / 1000).toFixed(2)}s
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="kd-faint">把曲库歌曲拖到这里，或用下面搜索</span>
              )}
            </div>
            <div className="kd-queue-bind-search">
              <Search size={12} />
              <input
                type="search"
                value={trackQuery}
                placeholder="搜索曲库绑定…"
                disabled={!canEdit || Boolean(busy)}
                onChange={(event) => setTrackQuery(event.target.value)}
              />
            </div>
            {trackHits.length > 0 ? (
              <ul className="kd-queue-bind-hits">
                {trackHits.map((track) => (
                  <li key={track.id}>
                    <button
                      type="button"
                      disabled={!canEdit || Boolean(busy)}
                      onClick={() => {
                        void run("绑定曲目", async () => {
                          bindTrack(track);
                          const result = await api.videoCalibrate(track.id, bvid, pageIndex);
                          const next = patchVideoDraft(task.id, {
                            offsetMode: "bound",
                            boundTrackId: track.id,
                            boundTrackTitle: track.title || track.filename,
                            boundTrackArtist: track.artist,
                            request: { offset_ms: Math.round(result.offset_ms) },
                          });
                          if (!next) return;
                          await applyVideoDraft(task, next);
                        });
                      }}
                    >
                      <span className="kd-truncate">{track.title || track.filename}</span>
                      <span className="kd-faint kd-truncate">{track.artist || DASH}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : searching ? (
              <p className="kd-faint" style={{ margin: 0, fontSize: "var(--kd-size-xs)" }}>
                搜索中…
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {busy ? (
        <p className="kd-faint" style={{ margin: 0, fontSize: "var(--kd-size-xs)" }}>
          {busy}…
        </p>
      ) : null}
      {error ? <p className="kd-queue-config-error">{error}</p> : null}
      {!canEdit ? (
        <p className="kd-faint" style={{ margin: 0, fontSize: "var(--kd-size-xs)" }}>
          已开始下载，参数已锁定。要改请取消后重新加入队列。
        </p>
      ) : null}
    </div>
  );
}

/** 取消 / 移除时顺手丢掉草稿，避免脏状态粘在下一个同 id 上。 */
export function discardQueueDraft(taskId: string): void {
  forgetQueueDraft(taskId);
}

export { rekeyQueueDraft };
