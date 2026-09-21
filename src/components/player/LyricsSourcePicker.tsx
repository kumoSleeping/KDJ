import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { ContextMenu } from "../common/ContextMenu";
import type { LyricsEngine } from "../../lib/lyricsPrefs";

const sources: { value: LyricsEngine; label: string }[] = [
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
  const label = sources.find(source => source.value === platform)?.label ?? "歌词来源";
  useEffect(() => {
    if (disabled || matching) setAnchor(null);
  }, [disabled, matching]);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".kd-lyrics-source-menu")) close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor]);
  const closeAndFocus = () => { setAnchor(null); trigger.current?.focus(); };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") { closeAndFocus(); return; }
    if (event.key === "Tab") { setAnchor(null); return; }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.closest('[role="menu"]')!.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <>
    <button ref={trigger} type="button" className="kd-lyrics-source-picker" disabled={disabled || matching}
      aria-label="选择歌词匹配平台" aria-haspopup="menu" aria-expanded={!!anchor} aria-busy={matching}
      title="为当前歌曲指定平台重新匹配歌词"
      onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 4, top: rect.top });
      }}>
      {matching ? "匹配中…" : label}<ChevronDown size={12} aria-hidden="true" />
    </button>
    {anchor && <ContextMenu x={anchor.x} y={anchor.y} anchorTop={anchor.top} onClose={() => setAnchor(null)} className="kd-lyrics-source-menu">
      {sources.map((source, index) => <button key={source.value} type="button" role="menuitemradio"
        aria-checked={platform === source.value}
        ref={node => { if (node && (platform === source.value || (!sources.some(item => item.value === platform) && index === 0))) node.focus(); }}
        onKeyDown={navigate} onClick={() => { closeAndFocus(); onSelect(source.value); }}>
        {source.label}
      </button>)}
    </ContextMenu>}
  </>;
}
