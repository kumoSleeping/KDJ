import { AudioWaveform, Captions, CircleAlert } from "lucide-react";

export interface TrackCacheFact {
  key: string;
  text: string;
  state: "running" | "done" | "failed" | "waiting";
}

const CACHE_FACT_ICON_SIZE = 12;

export function TrackCacheFactItem({ fact }: { fact: TrackCacheFact }) {
  return (
    <span
      className="kd-track-cache-fact"
      data-kind={fact.key}
      data-state={fact.state}
      aria-label={fact.text}
    >
      {fact.key === "waveform-cache" ? (
        <AudioWaveform
          className="kd-track-cache-fact-icon"
          size={CACHE_FACT_ICON_SIZE}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : null}
      {fact.key === "lyrics-cache" ? (
        <Captions
          className="kd-track-cache-fact-icon"
          size={CACHE_FACT_ICON_SIZE}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : null}
      <span>{fact.text}</span>
      {fact.state === "failed" ? (
        <CircleAlert
          className="kd-track-cache-state-icon"
          size={CACHE_FACT_ICON_SIZE}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

/** 波形和歌词始终作为一个整体换行，避免窄详情栏把两种轻量缓存拆开。 */
export function TrackAssetCacheFacts({ facts }: { facts: TrackCacheFact[] }) {
  if (facts.length === 0) return null;
  return (
    <span className="kd-track-cache-asset-facts">
      {facts.map((fact) => <TrackCacheFactItem key={fact.key} fact={fact} />)}
    </span>
  );
}
