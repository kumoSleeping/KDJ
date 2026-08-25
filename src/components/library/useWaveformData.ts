import { useEffect, useState } from "react";
import {
  cachedReleaseOverviewWaveform,
  cachedWaveform,
  loadReleaseOverviewById,
  loadReleaseOverviewForTrack,
  loadWaveformById,
  loadWaveformForTrack,
  streamWaveformSnapshot,
  subscribeStreamWaveform,
  updateStreamWaveform,
  type StreamWaveformSnapshot,
} from "../../lib/waveformCache";
import { isOneLibraryPlaybackTrack } from "../../lib/playbackTrackSource";
import { waveformUsesReleaseOverviewPalette } from "../../lib/waveformRenderPolicy";
import type { Track, Waveform } from "../../types";

/** Let a newly loaded Deck paint/respond before upgrading its cached 640-column preview. */
const DETAIL_WAVEFORM_IDLE_DELAY_MS = 750;

export interface WaveformDataRequest {
  trackId: number;
  track: Track | null;
  duration: number;
  buckets: number;
  providedWaveform?: Waveform;
  renderProfile: "current" | "release-overview";
  /** Cached previews paint immediately; this controls only the high-density background upgrade. */
  detailUpgradeDelayMs?: number;
}

interface OwnedWaveformState {
  owner: string;
  waveform: Waveform | null;
}

interface OwnedWaveformError {
  owner: string;
  message: string;
}

/**
 * Own waveform acquisition separately from the renderer and transport UI.
 *
 * Local, OneLibrary and progressive-stream tracks deliberately have different data sources. This
 * hook keeps those cache/profile rules in one place while the main component only consumes the
 * selected display waveform and progressive metadata.
 */
export function useWaveformData({
  trackId,
  track,
  duration,
  buckets,
  providedWaveform,
  renderProfile,
  detailUpgradeDelayMs = DETAIL_WAVEFORM_IDLE_DELAY_MS,
}: WaveformDataRequest): {
  displayReleaseOverview: boolean;
  displayWave: Waveform | null;
  error: string;
} {
  const oneLibraryTrack =
    track?.id === trackId && isOneLibraryPlaybackTrack(track) ? track : null;
  const progressiveStream = trackId < 0 && oneLibraryTrack === null;
  const releaseOverview = renderProfile === "release-overview";
  const displayReleaseOverview = waveformUsesReleaseOverviewPalette(renderProfile);
  // Callers that acquire the high-density rail in a parent hook also preserve that hook's state
  // for one render after a Deck swap. Never relabel such stale pixels as the replacement track.
  const ownedProvidedWaveform = providedWaveform?.track_id === trackId
    ? providedWaveform
    : undefined;
  // React preserves hook state while a Deck swaps tracks. Tag data with its source/profile owner
  // so the first render of the replacement cannot paint one frame of the previous track before
  // the acquisition effect resets it. Bucket upgrades intentionally share an owner: the cached
  // 640-column rail remains a valid preview while the detailed request is pending.
  const waveOwner = `${trackId}:${releaseOverview ? "release" : "current"}:${oneLibraryTrack?.source_key ?? ""}`;
  const [waveState, setWaveState] = useState<OwnedWaveformState>(() => ({
    owner: waveOwner,
    waveform: ownedProvidedWaveform ?? (releaseOverview
      ? cachedReleaseOverviewWaveform(trackId)
      : cachedWaveform(trackId, buckets)),
  }));
  const wave = waveState.owner === waveOwner ? waveState.waveform : null;
  const [streamSnapshot, setStreamSnapshot] = useState<StreamWaveformSnapshot | null>(() =>
    progressiveStream ? streamWaveformSnapshot(trackId) : null,
  );
  const [errorState, setErrorState] = useState<OwnedWaveformError>(() => ({
    owner: waveOwner,
    message: "",
  }));
  const error = errorState.owner === waveOwner ? errorState.message : "";

  useEffect(() => {
    const setWave = (waveform: Waveform | null) => setWaveState({ owner: waveOwner, waveform });
    const setError = (message: string) => setErrorState({ owner: waveOwner, message });
    if (ownedProvidedWaveform) {
      setWave(ownedProvidedWaveform);
      setError("");
      return;
    }
    if (progressiveStream) {
      // 在线曲的波形只由当前媒体的 buffered + analyser 渐进生成，不能从这里另拉整首。
      setWave(null);
      setError("");
      return;
    }
    let alive = true;
    if (releaseOverview) {
      const cached = cachedReleaseOverviewWaveform(trackId);
      setWave(cached);
      setError("");
      if (cached) return;
      const request = oneLibraryTrack
        ? loadReleaseOverviewForTrack(oneLibraryTrack)
        : loadReleaseOverviewById(trackId);
      void request
        .then((result) => {
          if (alive) setWave(result);
        })
        .catch((reason: unknown) => {
          if (alive) setError(reason instanceof Error ? reason.message : String(reason));
        });
      return () => {
        alive = false;
      };
    }

    // Performance 的局部滚动波形会按曲长要 100 列/秒，但曲库分析预先写好的是 640 桶。
    // 先拿 canonical 预览立即画，再在它之后后台升级；旧逻辑直接等详细档，等于
    // 每次装盘都绕开已有缓存现场整轨解码，overview 还会再用 960 解第二次。
    const previewBuckets = Math.min(640, buckets);
    const detailed = cachedWaveform(trackId, buckets);
    const preview = detailed ?? cachedWaveform(trackId, previewBuckets);
    setWave(preview);
    setError("");
    if (detailed) return;
    const loadAt = (count: number) => oneLibraryTrack
      ? loadWaveformForTrack(oneLibraryTrack, count)
      : loadWaveformById(trackId, count);
    // Keep a cached canonical rail responsive through a new Deck load. The detailed request is
    // intentionally deferred and globally serialized by the backend; current/predicted Decks
    // must not launch several full-track decodes while a platter or waveform needs input now.
    let detailTimer: number | null = null;
    const request = preview && buckets > previewBuckets
      ? new Promise<Waveform>((resolve, reject) => {
          detailTimer = window.setTimeout(() => {
            detailTimer = null;
            void loadAt(buckets).then(resolve, reject);
          }, Math.max(0, detailUpgradeDelayMs));
        })
      : loadAt(buckets);
    request
      .then((result) => {
        if (alive) setWave(result);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    // 切曲目时作废上一条请求，慢响应不会画到新曲子上。
    return () => {
      alive = false;
      if (detailTimer !== null) window.clearTimeout(detailTimer);
    };
  }, [
    trackId,
    oneLibraryTrack?.source_key,
    progressiveStream,
    buckets,
    ownedProvidedWaveform,
    releaseOverview,
    detailUpgradeDelayMs,
  ]);

  useEffect(() => {
    if (!progressiveStream) {
      setStreamSnapshot(null);
      return;
    }
    const sync = () => setStreamSnapshot(streamWaveformSnapshot(trackId));
    const unsubscribe = subscribeStreamWaveform(trackId, sync);
    // 首帧也建固定桶：即使媒体还没触发 progress，底栏仍有“未缓存”基线。
    if (!streamWaveformSnapshot(trackId)) {
      updateStreamWaveform(trackId, 0, duration, null, []);
    }
    sync();
    return unsubscribe;
  }, [trackId, progressiveStream]);

  useEffect(() => {
    if (progressiveStream && duration > 0) {
      // loadedmetadata 可能晚于首帧；只补时长，不清掉 PlayerBar 已喂入的缓存区间。
      updateStreamWaveform(trackId, 0, duration, null);
    }
  }, [trackId, duration, progressiveStream]);

  const activeStreamSnapshot =
    streamSnapshot?.waveform.track_id === trackId ? streamSnapshot : null;
  const displayWave = progressiveStream
    ? releaseOverview
      ? activeStreamSnapshot?.waveform ?? null
      : activeStreamSnapshot?.detailWaveform ?? activeStreamSnapshot?.waveform ?? null
    : wave;

  return {
    displayReleaseOverview,
    displayWave,
    error,
  };
}
