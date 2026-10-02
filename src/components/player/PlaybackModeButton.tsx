import { useRef, useState } from "react";
import { FolderOpen, Library, Repeat, Repeat1, Shuffle, Waypoints } from "lucide-react";
import { usePlayMode, type PlayMode } from "../../lib/playMode";
import { useHarmonicScope } from "../../lib/harmonicScope";
import { ContextMenu } from "../common/ContextMenu";

export const MODE_UI: Record<PlayMode, { icon: typeof Repeat; label: string; hint: string }> = {
  harmonic: { icon: Waypoints, label: "调性接歌", hint: "放完自动接调性 / BPM 合拍的下一首" },
  order: { icon: Repeat, label: "顺序播放", hint: "按列表顺序放，到头绕回第一首" },
  shuffle: { icon: Shuffle, label: "随机播放", hint: "在范围内随机挑，优先没放过的" },
  one: { icon: Repeat1, label: "单曲循环", hint: "一直放这一首；手动按下一首仍会换歌" },
};

/** One entry for next-track policy; mode and scope retain their existing shared stores. */
export function PlaybackModeButton() {
  const mode = usePlayMode(state => state.mode);
  const setMode = usePlayMode(state => state.setMode);
  const scope = useHarmonicScope(state => state.scope);
  const setScope = useHarmonicScope(state => state.setScope);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; top: number } | null>(null);
  const Icon = MODE_UI[mode].icon;
  const label = `${MODE_UI[mode].label} · ${scope === "folder" ? "当前文件夹" : "全部曲库"}`;
  const close = () => { setMenu(null); button.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={button} type="button" className="kd-player-step kd-player-mode" aria-label={`播放模式与范围：${label}`}
      title={label} aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? "kd-playback-mode-menu" : undefined}
      onClick={event => {
        if (menu) { setMenu(null); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ x: rect.left, y: rect.bottom + 4, top: rect.top });
      }}><Icon size={14} /></button>
    {menu && <ContextMenu id="kd-playback-mode-menu" label="播放模式与范围" x={menu.x} y={menu.y} anchorTop={menu.top}
      minWidth={170} onClose={() => setMenu(null)} keepOpen=".kd-player-mode">
      <div className="kd-lyrics-menu-heading" role="presentation">播放模式</div>
      {(Object.keys(MODE_UI) as PlayMode[]).map(value => {
        const item = MODE_UI[value];
        return <button key={value} type="button" role="menuitemradio" aria-checked={mode === value} title={item.hint}
          onClick={() => { setMode(value); close(); }}><item.icon size={14} />{item.label}</button>;
      })}
      <div className="kd-lyrics-menu-heading" role="presentation">播放范围</div>
      <button type="button" role="menuitemradio" aria-checked={scope === "folder"}
        onClick={() => { setScope("folder"); close(); }}><FolderOpen size={14} />当前文件夹</button>
      <button type="button" role="menuitemradio" aria-checked={scope === "all"}
        onClick={() => { setScope("all"); close(); }}><Library size={14} />全部曲库</button>
    </ContextMenu>}
  </>;
}
