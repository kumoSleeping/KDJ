import { useEffect, useState } from "react";
import {
  cachedReleaseOverviewWaveform,
  cachedWaveform,
  deferredOverviewRetryDelay,
  isPlaybackDeferredWaveformError,
  isSupersededWaveformError,
  loadReleaseOverviewById,
  loadWaveformById,
  streamWaveformSnapshot,
  subscribeStreamWaveform,
  updateStreamWaveform,
  type ReleaseOverviewRequestIntent,
  type StreamWaveformSnapshot,
} from "../../lib/waveformCache";
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
  /** Render only caller-owned data; never fall back to a full-track library request. */
  providedOnly?: boolean;
  renderProfile: "current" | "release-overview";
  /** Global PlayerBar is latest-wins; ordinary visible rails may coexist. */
  releaseOverviewIntent?: Exclude<ReleaseOverviewRequestIntent, "prefetch">;
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
 * Local and progressive-stream tracks deliberately have different data sources. This
 * hook keeps those cache/profile rules in one place while the main component only consumes the
 * selected display waveform and progressive metadata.
 */
export function useWaveformData({
  trackId,
  duration,
  buckets,
  providedWaveform,
  providedOnly = false,
  renderProfile,
  releaseOverviewIntent = "visible",
  detailUpgradeDelayMs = DETAIL_WAVEFORM_IDLE_DELAY_MS,
}: WaveformDataRequest): {
  displayReleaseOverview: boolean;
  displayWave: Waveform | null;
  error: string;
} {
  const progressiveStream = trackId < 0;
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
  const waveOwner = `${trackId}:${releaseOverview ? "release" : "current"}:${providedOnly ? "provided" : "library"}`;
  const immediateWave = ownedProvidedWaveform ?? (providedOnly
    ? null
    : releaseOverview
      ? cachedReleaseOverviewWaveform(trackId)
      : cachedWaveform(trackId, buckets) ?? cachedReleaseOverviewWaveform(trackId));
  const [waveState, setWaveState] = useState<OwnedWaveformState>(() => ({
    owner: waveOwner,
    waveform: immediateWave,
  }));
  // A Deck swap reuses this hook instance. Read the replacement track's cached overview during
  // render instead of waiting one effect/paint before replacing the old owner's state.
  const wave = waveState.owner === waveOwner ? waveState.waveform : immediateWave;
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
    if (providedOnly) {
      setWave(ownedProvidedWaveform ?? null);
      setError("");
      return;
    }
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
      let retryTimer: number | null = null;
      let deferredAttempts = 0;
      const cached = cachedReleaseOverviewWaveform(trackId);
      setWave(cached);
      setError("");
      if (cached) {
        // A JS-memory hit still advances the PlayerBar's native latest-wins lane, cancelling a
        // detached cold decode for the track that was visible one render ago.
        if (releaseOverviewIntent === "player") {
          void loadReleaseOverviewById(trackId, releaseOverviewIntent).catch(() => undefined);
        }
        return;
      }
      const load = () => {
        retryTimer = null;
        void loadReleaseOverviewById(trackId, releaseOverviewIntent)
          .then((result) => {
            if (alive) setWave(result);
          })
          .catch((reason: unknown) => {
            if (!alive) return;
            if (isSupersededWaveformError(reason)) {
              setError("");
              return;
            }
            if (isPlaybackDeferredWaveformError(reason)) {
              // Deferral is a scheduling result, not an asset failure. Keep the rail quiet and
              // retry so a later Pause/healthy gap cannot leave this mounted preview blank for
              // the rest of the session.
              setError("");
              const retryDelay = deferredOverviewRetryDelay(deferredAttempts);
              deferredAttempts += 1;
              retryTimer = window.setTimeout(load, retryDelay);
              return;
            }
            setError(reason instanceof Error ? reason.message : String(reason));
          });
      };
      load();
      return () => {
        alive = false;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
      };
    }

    // Generic current-profile callers may still request a dense full-song asset. The Manager
    // never enters this branch: `providedOnly` binds it to bounded playback PCM and prevents a
    // future refactor from silently reviving full-track decode on its compact rail.
    const previewBuckets = Math.min(640, buckets);
    const detailed = cachedWaveform(trackId, buckets);
    const releasePreview = cachedReleaseOverviewWaveform(trackId);
    const preview = detailed
      // A 4,096-column release asset is a better generic preview than the 640-column overview.
      ?? releasePreview
      ?? cachedWaveform(trackId, previewBuckets);
    setWave(preview);
    setError("");
    if (detailed) return;
    const loadAt = (count: number) => loadWaveformById(trackId, count);
    // Keep a cached canonical rail responsive through a new Deck load. The detailed request is
    // intentionally deferred and globally serialized by the backend; current/predicted Decks
    // must not launch several full-track decodes while a platter or waveform needs input now.
    let detailTimer: number | null = null;
    const loadDetailed = () => new Promise<Waveform>((resolve, reject) => {
      detailTimer = window.setTimeout(() => {
        detailTimer = null;
        void loadAt(buckets).then(resolve, reject);
      }, Math.max(0, detailUpgradeDelayMs));
    });
    const request = preview
      ? buckets > previewBuckets ? loadDetailed() : Promise.resolve(preview)
      : buckets > previewBuckets
        ? loadAt(previewBuckets).then((initial) => {
            if (alive) setWave(initial);
            return loadDetailed();
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
    progressiveStream,
    buckets,
    ownedProvidedWaveform,
    providedOnly,
    releaseOverview,
    releaseOverviewIntent,
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
    ? activeStreamSnapshot?.waveform ?? null
    : wave;

  return {
    displayReleaseOverview,
    displayWave,
    error,
  };
}
