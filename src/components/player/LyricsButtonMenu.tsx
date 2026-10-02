import { useCallback, useSyncExternalStore } from "react";
import { ContextMenu } from "../common/ContextMenu";
import { lyricSources } from "./LyricsSourcePicker";
import { useLyricsPrefs, type LyricsExtra } from "../../lib/lyricsPrefs";
import { useLyricsStore } from "../../stores/lyricsStore";
import type { Track } from "../../types";

const layers: { value: LyricsExtra; label: string }[] = [
  { value: "off", label: "原词" },
  { value: "meaning", label: "中文翻译" },
  { value: "romaji", label: "罗马字" },
];

/** 播放条悬浮歌词按钮的右键设置；来源只为当前歌曲重新匹配。 */
export function LyricsButtonMenu({ x, y, top, track, onClose }: {
  x: number;
  y: number;
  top: number;
  track: Track | null;
  onClose(): void;
}) {
  const layer = useLyricsPrefs((state) => state.lyricExtra);
  const setLayer = useLyricsPrefs((state) => state.setLyricExtra);
  const locked = useLyricsPrefs((state) => state.desktopLocked);
  const setLocked = useLyricsPrefs((state) => state.setDesktopLocked);
  const focusFirst = useCallback((node: HTMLButtonElement | null) => { node?.focus(); }, []);
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(track?.id),
    () => useLyricsStore.getState().get(track?.id),
  );
  return (
    <ContextMenu x={x} y={y} anchorTop={top} onClose={onClose} className="kd-lyrics-button-menu">
      <div className="kd-lyrics-menu-heading" role="presentation">附加歌词</div>
      {layers.map(({ value, label }, index) => (
        <button key={value} type="button" role="menuitemradio" aria-checked={layer === value}
          ref={index === 0 ? focusFirst : undefined}
          onClick={() => { setLayer(value); onClose(); }}>{label}</button>
      ))}
      <div className="kd-lyrics-menu-heading" role="presentation">悬浮歌词</div>
      <button type="button" role="menuitemcheckbox" aria-checked={locked}
        title="关闭穿透后可拖动悬浮歌词"
        onClick={() => { setLocked(!locked); onClose(); }}>{window.kdj?.overlayPermission ? "触摸穿透" : "鼠标穿透"}</button>
      <div className="kd-lyrics-menu-heading" role="presentation">当前歌曲的歌词来源</div>
      {lyricSources.map(({ value, label }) => (
        <button key={value} type="button" role="menuitemradio"
          aria-checked={entry.meta?.platform === value}
          disabled={!track || !!entry.inflight}
          onClick={() => {
            if (!track) return;
            onClose();
            void useLyricsStore.getState().ensure(track, { platform: value });
          }}>{label}</button>
      ))}
    </ContextMenu>
  );
}
