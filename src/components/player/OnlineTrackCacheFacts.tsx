import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { formatBytes } from "../../lib/format";
import { lyricsCacheBytes, waveformCacheBytes } from "../../lib/onlineCacheUsage";
import {
  downloadTaskMatchesSource,
  downloadTaskProgressStages,
  selectOnlineProgressTask,
  terminalTaskRetentionSeconds,
} from "../../lib/onlineTaskProgress";
import type { SongPreviewState } from "../../lib/songPreview";
import {
  streamCacheProgressSnapshot,
  subscribeStreamCacheProgress,
} from "../../lib/streamCacheProgress";
import {
  streamWaveformSnapshot,
  subscribeStreamWaveform,
} from "../../lib/waveformCache";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import type { DownloadTask, SongSource } from "../../types";
import {
  TrackAssetCacheFacts,
  TrackCacheFactItem,
  type TrackCacheFact,
} from "./TrackCacheFacts";

function useTerminalExpiryClock(tasks: DownloadTask[]): number {
  const [tick, expire] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const task of tasks) {
      const retention = terminalTaskRetentionSeconds(task);
      if (retention <= 0) continue;
      const expiry = task.updated_at * 1000 + retention * 1000;
      if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(expire, Math.max(32, nextExpiry - now + 32));
    return () => window.clearTimeout(timer);
  }, [tasks, tick]);
  return Date.now() / 1000;
}

function taskFact(task: DownloadTask): TrackCacheFact | null {
  const stages = downloadTaskProgressStages(task);
  const stage = stages.find((item) => item.state === "running")
    ?? [...stages].reverse().find((item) => item.state === "failed")
    ?? [...stages].reverse().find((item) => item.state === "done")
    ?? stages[0];
  if (!stage) return null;
  const label = stage.kind === "resolve" ? "解析" : "下载";
  const state = stage.state === "failed" ? "failed" : stage.state === "done" ? "done" : "running";
  const progress = stage.state === "running" && !stage.indeterminate
    ? ` ${Math.round(Math.min(1, Math.max(0, stage.value)) * 100)}%`
    : "";
  const suffix = stage.state === "done" ? "完成" : stage.state === "failed" ? "失败" : "中";
  return {
    key: "download-task",
    text: `${label}${progress || suffix}`,
    state,
  };
}

/**
 * 在线缓存不再占独立面板；所有状态都作为封面旁的紧凑事实展示。
 * 有精确字节/百分比就直接写数字，只有无法量化的阶段才显示“中”。
 */
export function OnlineTrackCacheFacts({
  source,
  preview,
  trackId,
}: {
  source: SongSource | null;
  preview: SongPreviewState | null;
  trackId: number | null;
}) {
  const tasks = useDownloadStore((state) => state.list);
  const now = useTerminalExpiryClock(tasks);
  const streamTrackId = trackId != null && trackId < 0 ? trackId : 0;
  const subscribeCache = useCallback(
    (listener: () => void) => subscribeStreamCacheProgress(streamTrackId, listener),
    [streamTrackId],
  );
  const readCache = useCallback(
    () => streamCacheProgressSnapshot(streamTrackId),
    [streamTrackId],
  );
  const cache = useSyncExternalStore(subscribeCache, readCache, readCache);
  const subscribeWaveform = useCallback(
    (listener: () => void) =>
      streamTrackId < 0 ? subscribeStreamWaveform(streamTrackId, listener) : () => {},
    [streamTrackId],
  );
  const readWaveform = useCallback(
    () => (streamTrackId < 0 ? streamWaveformSnapshot(streamTrackId) : null),
    [streamTrackId],
  );
  const waveform = useSyncExternalStore(subscribeWaveform, readWaveform, readWaveform);
  const lyrics = useLyricsStore((state) => state.get(streamTrackId < 0 ? streamTrackId : null));

  const waveformUsage = useMemo(() => {
    if (!waveform) return { bytes: 0, ratio: 0 };
    const total = waveform.known.length;
    const known = waveform.known.reduce((count, value) => count + (value ? 1 : 0), 0);
    return {
      bytes: waveformCacheBytes(waveform.waveform),
      ratio: total > 0 ? known / total : 0,
    };
  }, [waveform]);
  const lyricBytes = useMemo(() => lyricsCacheBytes(lyrics.meta), [lyrics.meta]);
  if (!source) return null;

  const facts: TrackCacheFact[] = [];
  if (preview?.phase === "resolving") {
    facts.push({ key: "resolve", text: "解析中", state: "running" });
  }

  if (streamTrackId < 0) {
    const cacheSize = cache.cachedBytes > 0 ? formatBytes(cache.cachedBytes) : "";
    const totalSize = cache.totalBytes > cache.cachedBytes ? formatBytes(cache.totalBytes) : "";
    facts.push({
      key: "media-cache",
      text: cache.complete
        ? `缓存 ${cacheSize || "完成"}`
        : cache.active
          ? cacheSize
            ? `缓存 ${cacheSize}${totalSize ? ` / ${totalSize}` : ""}`
            : "缓存中"
          : cacheSize
            ? `缓存 ${cacheSize}`
            : "缓存未开始",
      state: cache.complete ? "done" : cache.active ? "running" : "waiting",
    });
  } else {
    facts.push({ key: "media-cache", text: "缓存未开始", state: "waiting" });
  }

  if (waveformUsage.bytes > 0) {
    const done = waveformUsage.ratio >= 0.999;
    facts.push({
      key: "waveform-cache",
      text: done
        ? `波形 ${formatBytes(waveformUsage.bytes)}`
        : `波形 ${formatBytes(waveformUsage.bytes)} · ${Math.round(waveformUsage.ratio * 100)}%`,
      state: done ? "done" : "running",
    });
  }
  const task = selectOnlineProgressTask(
    tasks.filter((item) => item.platform !== "local"),
    source,
    now,
  );
  if (task && downloadTaskMatchesSource(task, source)) {
    const fact = taskFact(task);
    if (fact) facts.push(fact);
  }

  // 歌词固定跟在波形后面；两种轻量缓存在详情顶部并排展示。
  if (lyrics.status !== "idle") {
    facts.push({
      key: "lyrics-cache",
      text: lyrics.status === "ready"
        ? `歌词 ${lyricBytes > 0 ? formatBytes(lyricBytes) : "完成"}`
        : lyrics.status === "empty"
          ? "无歌词"
          : lyrics.status === "error"
            ? "歌词失败"
            : "歌词缓存中",
      state: lyrics.status === "ready" || lyrics.status === "empty"
        ? "done"
        : lyrics.status === "error"
          ? "failed"
          : "running",
    });
  }

  const assetFacts = facts.filter(
    (fact) => fact.key === "waveform-cache" || fact.key === "lyrics-cache",
  );
  const leadingFacts = facts.filter(
    (fact) => fact.key !== "waveform-cache" && fact.key !== "lyrics-cache",
  );

  return (
    <>
      {leadingFacts.map((fact) => <TrackCacheFactItem key={fact.key} fact={fact} />)}
      <TrackAssetCacheFacts facts={assetFacts} />
    </>
  );
}
