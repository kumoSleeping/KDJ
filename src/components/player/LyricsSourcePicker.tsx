import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ContextMenu } from "../common/ContextMenu";
import type { LyricsEngine } from "../../lib/lyricsPrefs";

export const lyricSources: { value: LyricsEngine; label: string }[] = [
  { value: "wyy", label: "网易云" },
  { value: "qqm", label: "QQ 音乐" },
  { value: "ytm", label: "YouTube Music" },
];

/** Explicit, per-song rematching; this control never changes global preferences. */
export function LyricsSourcePicker({ platform, disabled = false, matching = false, onSelect }: {
  platform?: string;
  disabled?: boolean;
  matching?: boolean;
  onSelect(platform: LyricsEngine): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; top: number } | null>(null);
  const label = lyricSources.find(source => source.value === platform)?.label ?? "歌词来源";
  useEffect(() => {
    if (disabled || matching) setAnchor(null);
  }, [disabled, matching]);
  const closeAndFocus = () => { setAnchor(null); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className="kd-lyrics-source-picker" disabled={disabled || matching}
      aria-label="选择歌词匹配平台" aria-haspopup="menu" aria-expanded={!!anchor} aria-busy={matching}
      title="为当前歌曲指定平台重新匹配歌词"
      onClick={() => {
        trigger.current!.focus({ preventScroll: true });
        const rect = trigger.current!.getBoundingClientRect();
        setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 4, top: rect.top });
      }}>
      {matching ? "匹配中…" : label}<ChevronDown size={12} aria-hidden="true" />
    </button>
    {anchor && <ContextMenu x={anchor.x} y={anchor.y} anchorTop={anchor.top} onClose={() => setAnchor(null)}
      keepOpen=".kd-lyrics-source-picker" className="kd-lyrics-source-menu">
      {lyricSources.map(source => <button key={source.value} type="button" role="menuitemradio"
        aria-checked={platform === source.value}
        onClick={() => { closeAndFocus(); onSelect(source.value); }}>
        {source.label}
      </button>)}
    </ContextMenu>}
  </>;
}
