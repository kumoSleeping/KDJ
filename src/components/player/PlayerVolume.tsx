import { memo, type CSSProperties, type RefObject } from "react";
import { useMasterVolume } from "../../lib/masterVolume";

/**
 * The player bar's volume slider. It reads the shared volume itself, so a drag re-renders
 * this label and not the whole player bar around it.
 */
export const PlayerVolume = memo(function PlayerVolume({ meterRef }: { meterRef: RefObject<HTMLSpanElement | null> }) {
  const volume = useMasterVolume((state) => state.volume);
  const setVolume = useMasterVolume((state) => state.setVolume);
  return (
    <label
      className="kd-player-volume"
      title={`音量 ${Math.round(volume * 100)}%（↑↓）`}
      data-muted={volume === 0 ? "true" : undefined}
      style={{ "--kd-volume-fill": `${volume * 100}%` } as CSSProperties}
    >
      <span ref={meterRef} className="kd-player-volume-leds" aria-hidden="true">
        <span className="kd-player-volume-row" data-slice="previous"><i /></span>
        <span className="kd-player-volume-row" data-slice="current"><i /></span>
      </span>
      <b className="kd-player-volume-thumb" aria-hidden="true" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        aria-label="播放器音量"
        onChange={(event) => setVolume(Number(event.currentTarget.value))}
      />
    </label>
  );
});
