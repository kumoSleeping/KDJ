import { useEffect } from "react";
import { api } from "../../lib/api";
import { useLyricsPresentation } from "../../lib/lyricsPresentation";
import { getPlayerSession, subscribePlayerSession } from "../../lib/playerSession";
import { streamCoverUrls } from "../../lib/streamTrack";
import { cachedReleaseOverviewWaveform, streamWaveformSnapshot } from "../../lib/waveformCache";
import { extractStudioPalette } from "../../lib/visualizerStudioPalette";
import { prefersReducedMotion } from "../../lib/motion";
import type { Track } from "../../types";

/** Shared cover colours, consumed only by the lyrics sheet and the playing-song bubble. */
export function useSongColor(track: Track | null) {
  const enabled = useLyricsPresentation(state => state.color);
  useEffect(() => {
    const root = document.documentElement;
    if (!enabled || !track) { delete root.dataset.songColor; return; }
    let stopped = false;
    const urls = track.id > 0 ? [api.coverUrl(track.id, track.modified_at, 256)] : streamCoverUrls(track);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    let next = 0;
    const load = () => { if (!stopped && next < urls.length) image.src = urls[next++]; };
    image.onerror = load;
    image.onload = () => {
      if (stopped) return;
      try {
        const palette = extractStudioPalette(image);
        const colors = palette.colors.map(item => item.color);
        root.style.setProperty("--kd-song-color-a", colors[0] ?? palette.accent);
        root.style.setProperty("--kd-song-color-b", colors[1] ?? palette.accent);
        root.style.setProperty("--kd-song-color-c", colors[2] ?? palette.accent);
        root.dataset.songColor = "true";
      } catch { load(); }
    };
    // Remove the preceding cover's colours before trying a new one.
    delete root.dataset.songColor;
    load();
    let last = -Infinity;
    const paint = () => {
      const session = getPlayerSession();
      if (session.trackId !== track.id || !session.playing || prefersReducedMotion()) return;
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      const wave = track.id < 0 ? streamWaveformSnapshot(track.id)?.waveform : cachedReleaseOverviewWaveform(track.id);
      const total = session.duration || track.duration || 0;
      const index = wave && total > 0 ? Math.min(wave.amp.length - 1, Math.floor(session.position / total * wave.amp.length)) : -1;
      const level = Math.max(0, Math.min(1, wave?.amp[index] ?? 0));
      root.style.setProperty("--kd-song-pulse", String(1 + level * 0.12));
      root.style.setProperty("--kd-song-drift", `${Math.sin(session.position / 5) * 4}%`);
    };
    const stop = subscribePlayerSession(paint);
    return () => { stopped = true; image.onload = image.onerror = null; stop(); delete root.dataset.songColor; };
  }, [enabled, track?.id, track?.modified_at]);
}
