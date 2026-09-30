import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { formatDuration } from "../../lib/format";
import { useMasterVolume } from "../../lib/masterVolume";

/** Control the audible output owner, never unmute a picture-only video element. */
function FloatingVideoVolume() {
  const volume = useMasterVolume(state => state.volume);
  const setVolume = useMasterVolume(state => state.setVolume);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const previousVolume = useRef(volume || 1);
  const panelId = useId();
  const percent = Math.round(volume * 100);
  useEffect(() => { if (volume > 0) previousVolume.current = volume; }, [volume]);
  useEffect(() => {
    if (!open) return;
    slider.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);
  return <div ref={root} className="kd-pip-volume" onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); button.current?.focus(); }
    }}>
    <button ref={button} type="button" aria-label={`音量 ${percent}%`} title={`音量 ${percent}%（与主音量同步）`}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      {volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
    </button>
    {open && <div id={panelId} className="kd-pip-volume-panel" role="group" aria-label="音量调节">
      <button type="button" aria-label={volume === 0 ? "取消静音" : "静音"} title={volume === 0 ? "取消静音" : "静音"}
        aria-pressed={volume === 0} onClick={() => setVolume(volume > 0 ? 0 : previousVolume.current)}>
        {volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      <input ref={slider} type="range" min={0} max={100} step={1} value={percent} aria-label="音量"
        aria-valuetext={`${percent}%`} onChange={event => setVolume(Number(event.currentTarget.value) / 100)} />
      <span className="kd-mono">{percent}%</span>
    </div>}
  </div>;
}

/** Shared by local playback and the workshop. Chrome stays inside the picture. */
export function FloatingVideoControls({ title, playing, position, duration, fullscreen, showTitle = true, showVolume = true, onClose, onToggle, onFullscreen, onTitlePointerDown, extra, error, closeLabel = "关闭预览" }: {
  title: string; playing: boolean; position: number; duration: number; fullscreen: boolean; showTitle?: boolean; showVolume?: boolean;
  onClose?(): void; onToggle(): void; onFullscreen(): void; extra?: ReactNode; error?: string; closeLabel?: string;
  onTitlePointerDown?: HTMLAttributes<HTMLDivElement>["onPointerDown"];
}) {
  return <div className="kd-pip-float-chrome" data-no-title={!showTitle || undefined} title={showTitle ? title : undefined}>
    {showTitle && <div className="kd-pip-float-top" onPointerDown={onTitlePointerDown} data-window-drag={Boolean(onTitlePointerDown) || undefined}>
      <span className="kd-truncate">{title}</span>
      {onClose && <button type="button" className="kd-pip-float-x" aria-label={closeLabel}
        onClick={e => { e.stopPropagation(); onClose(); }}><X size={13} /></button>}
    </div>}
    <div className="kd-pip-float-bottom">
      <button type="button" aria-label={playing ? "暂停" : "播放"}
        onClick={e => { e.stopPropagation(); onToggle(); }}>
        {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
      </button>
      <span className="kd-mono">{formatDuration(position)} / {formatDuration(duration)}</span>
      <button type="button" aria-label={fullscreen ? "退出全屏" : "全屏播放"} aria-pressed={fullscreen}
        title={fullscreen ? "退出全屏（Esc）" : "全屏播放"}
        onClick={e => { e.stopPropagation(); onFullscreen(); }}>
        {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      {showVolume && <FloatingVideoVolume />}
      {extra}
    </div>
    {error && <div className="kd-pip-float-error">{error}</div>}
  </div>;
}

export function FloatingVideoScrub({ position, duration, ...props }: HTMLAttributes<HTMLDivElement> & {position: number; duration: number}) {
  return <div className="kd-pip-float-scrub" role="slider" tabIndex={0} aria-label="视频进度"
    aria-valuemin={0} aria-valuemax={duration} aria-valuenow={position} {...props}>
    <span className="kd-pip-float-scrub-fill" style={{width: `${duration > 0 ? Math.min(100, Math.max(0, position / duration * 100)) : 0}%`}} />
  </div>;
}
