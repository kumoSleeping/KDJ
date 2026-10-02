import { useEffect, useState } from "react";
import type { Track, Waveform } from "../../types";
import { cachedWaveform, isPlaybackDeferredWaveformError, loadWaveform } from "../../lib/waveformCache";
import { detailWaveformBuckets } from "../../lib/waveformViewport";
import { useWaveformData } from "../library/useWaveformData";

/** No clock subscription, seek requests, rolling PCM reads or window polling. */
export function useStaticPlaybackWaveform(track: Track, duration: number) {
  const preview = useWaveformData({ trackId: track.id, track, duration,
    buckets: 4096, renderProfile: "release-overview" });
  const buckets = detailWaveformBuckets(duration);
  const durationKnown = duration > 0;
  const [detail, setDetail] = useState<Waveform | null>(null);
  useEffect(() => {
    // Keep this song's existing bitmap source while a more precise duration/detail
    // arrives. Deck handoffs during seek must not drop it back to an empty overview.
    setDetail(current => current?.track_id === track.id ? current : null);
    if (track.id < 0 || !durationKnown) return;
    const cached = cachedWaveform(track.id, buckets);
    if (cached) { setDetail(cached); return; }
    let alive = true;
    let timer: number;
    const load = () => {
      // The existing backend's background lane yields to transport under output pressure.
      void loadWaveform(track.id, buckets, true).then(wave => {
        if (alive) setDetail(wave);
      }).catch(error => {
        if (alive && isPlaybackDeferredWaveformError(error)) timer = window.setTimeout(load, 5000);
      });
    };
    timer = window.setTimeout(load, 1500);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [track.id, durationKnown, buckets]);
  const ownedDetail = detail?.track_id === track.id ? detail : null;
  return { overview: preview.displayWave, detail: ownedDetail ?? preview.displayWave,
    loading: !preview.displayWave && !ownedDetail && !preview.error, error: preview.error };
}
