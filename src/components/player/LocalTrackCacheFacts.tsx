import { useEffect, useMemo, useState } from "react";
import { formatBytes } from "../../lib/format";
import { lyricsCacheBytes, waveformCacheBytes } from "../../lib/onlineCacheUsage";
import {
  cachedReleaseOverviewWaveform,
  loadReleaseOverviewById,
  subscribeReleaseOverviewWaveform,
} from "../../lib/waveformCache";
import { ensureLyrics, useLyricsStore } from "../../stores/lyricsStore";
import type { Platform, Track, Waveform } from "../../types";
import { TrackAssetCacheFacts, type TrackCacheFact } from "./TrackCacheFacts";

type DownloadPlatform = Exclude<Platform, "local">;
type WaveformState = "loading" | "ready" | "failed";

export function localDownloadPlatform(track: Track): DownloadPlatform | null {
  const platform = track.source_platform?.trim().toLowerCase();
  if (
    platform === "wyy"
    || platform === "qqm"
    || platform === "soundcloud"
    || platform === "ytm"
    || platform === "youtube"
    || platform === "bilibili"
  ) {
    return platform;
  }
  return null;
}

/** 本地曲目统一展示波形与持久歌词缓存；来源徽标仍按真实下载身份判断。 */
export function LocalTrackCacheFacts({ track }: { track: Track }) {
  const lyrics = useLyricsStore((state) => state.get(track.id));
  const cachedWaveform = cachedReleaseOverviewWaveform(track.id);
  const [waveform, setWaveform] = useState<Waveform | null>(cachedWaveform);
  const [waveformState, setWaveformState] = useState<WaveformState>(
    cachedWaveform ? "ready" : "loading",
  );

  useEffect(() => {
    let current = true;
    const syncCachedWaveform = () => {
      if (!current) return;
      const cached = cachedReleaseOverviewWaveform(track.id);
      if (!cached) return;
      setWaveform(cached);
      setWaveformState("ready");
    };
    const unsubscribe = subscribeReleaseOverviewWaveform(track.id, syncCachedWaveform);
    const cached = cachedReleaseOverviewWaveform(track.id);
    setWaveform(cached);
    setWaveformState(cached ? "ready" : "loading");
    void loadReleaseOverviewById(track.id)
      .then((next) => {
        if (!current) return;
        setWaveform(next);
        setWaveformState("ready");
      })
      .catch(() => {
        if (!current) return;
        // 详情栏的 visible 请求可能被 PlayerBar 的同曲 player 请求取代。
        // 先重读共享缓存，不能用旧请求的结果覆盖已经成功的新请求。
        const next = cachedReleaseOverviewWaveform(track.id);
        setWaveform(next);
        setWaveformState(next ? "ready" : "failed");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [track.analyzed_at, track.id, track.modified_at]);

  useEffect(() => {
    void ensureLyrics(track);
    // 标题与来源变化时允许歌词仓库按自己的指纹/命中规则重新判断。
  }, [track.artist, track.filename, track.id, track.source_key, track.source_platform, track.title]);

  const facts = useMemo<TrackCacheFact[]>(() => {
    const waveformBytes = waveformCacheBytes(waveform);
    const lyricBytes = lyricsCacheBytes(lyrics.meta);
    return [
      {
        key: "waveform-cache",
        text: waveformState === "ready"
          ? `波形 ${waveformBytes > 0 ? formatBytes(waveformBytes) : "完成"}`
          : waveformState === "failed"
            ? "波形未缓存"
            : "波形缓存中",
        state: waveformState === "ready"
          ? "done"
          : waveformState === "failed"
            ? "waiting"
            : "running",
      },
      {
        key: "lyrics-cache",
        text: lyrics.status === "ready"
          ? lyrics.persisted
            ? `歌词 ${lyricBytes > 0 ? formatBytes(lyricBytes) : "完成"}`
            : "歌词未缓存"
          : lyrics.status === "empty"
            ? "无歌词"
            : lyrics.status === "error"
              ? "歌词失败"
              : "歌词缓存中",
        state: lyrics.status === "ready"
          ? lyrics.persisted ? "done" : "failed"
          : lyrics.status === "empty"
            ? "done"
          : lyrics.status === "error"
            ? "failed"
            : "running",
      },
    ];
  }, [lyrics.meta, lyrics.persisted, lyrics.status, waveform, waveformState]);

  return <TrackAssetCacheFacts facts={facts} />;
}
