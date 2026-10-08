import { useContext, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { LoaderCircle, Maximize2, Minimize2, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { formatDuration } from "../../lib/format";
import { useMasterVolume, useMonitorVolume } from "../../lib/masterVolume";
import { PanelMediaControlsContext } from "../common/panelMediaControls";

export type VolumeChannel = "master" | "monitor";

function useVolumeChannel(channel: VolumeChannel) {
  const master = useMasterVolume(), monitor = useMonitorVolume();
  return channel === "monitor"
    ? { name: "监听音量", volume: monitor.volume, muted: monitor.muted || monitor.volume === 0, setVolume: monitor.setVolume, toggleMute: monitor.toggleMute }
    : { name: "音量", volume: master.volume, muted: master.volume === 0, setVolume: master.setVolume, toggleMute: master.toggleMute };
}

/** One volume control for every audible preview. It drives the output owner's
 * level (the shared master, or the editor's monitoring trim) and never unmutes
 * a picture-only video element. No backdrop or drag state outlives the popover.
 */
export function PreviewVolume({ channel = "master", layout = "popover" }: { channel?: VolumeChannel; layout?: "popover" | "inline" }) {
  const { name, volume, muted, setVolume, toggleMute } = useVolumeChannel(channel);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const percent = Math.round(volume * 100);
  const level = muted ? `${name} 已静音` : `${name} ${percent}%`;
  useEffect(() => {
    if (!open) return;
    slider.current?.focus({ preventScroll: true });
    const close = () => setOpen(false);
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close();
    };
    // WebKit does not focus buttons on click, so blur alone cannot tell an
    // inside click from leaving. Outside presses and window blur close it.
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
    };
  }, [open]);
  const icon = muted ? <VolumeX size={13} /> : <Volume2 size={13} />;
  const mute = <button type="button" aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"}
    aria-pressed={muted} onClick={toggleMute}>{icon}</button>;
  const range = <input ref={slider} type="range" min={0} max={100} step={1} value={percent} aria-label={name}
    aria-valuetext={muted ? "静音" : `${percent}%`} title={level}
    onChange={event => setVolume(Number(event.currentTarget.value) / 100)} />;
  return <div ref={root} className="kd-pip-volume" data-layout={layout} data-open={open || undefined} data-muted={muted || undefined}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onBlur={event => {
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
    }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }); }
    }}>
    {layout === "inline" ? <>{mute}{range}</> : <>
      <button ref={trigger} type="button" aria-label={level} title={level}
        aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>{icon}</button>
      {open && <div id={panelId} className="kd-pip-volume-panel" role="group" aria-label={name}>
        {mute}{range}<span className="kd-mono">{muted ? "静音" : `${percent}%`}</span>
      </div>}
    </>}
  </div>;
}

/** Shared by local playback and the workshop. Chrome stays inside the picture. */
export function FloatingVideoControls({ title, playing, loading = false, position, duration, fullscreen, showTitle = true, showVolume = true, volumeChannel = "master", onClose, onToggle, onFullscreen, onTitlePointerDown, extra, titleExtra, error, closeLabel = "关闭预览" }: {
  title: string; playing: boolean; loading?: boolean; position: number; duration: number; fullscreen: boolean; showTitle?: boolean; showVolume?: boolean;
  /** Which level this surface's sound actually passes through. */
  volumeChannel?: VolumeChannel;
  onClose?(): void; onToggle(): void; onFullscreen(): void; extra?: ReactNode; error?: string; closeLabel?: string;
  /** Controls for surfaces whose bottom row is owned by an embedded player. */
  titleExtra?: ReactNode;
  onTitlePointerDown?: HTMLAttributes<HTMLDivElement>["onPointerDown"];
}) {
  const panelToolsHost = useContext(PanelMediaControlsContext);
  return <>
    {panelToolsHost && !fullscreen && !showTitle && <div ref={panelToolsHost} className="kd-pip-float-panel-tools" />}
    <div className="kd-pip-float-chrome" data-no-title={!showTitle || undefined}>
      {showTitle && <div className="kd-pip-float-top" onPointerDown={onTitlePointerDown} data-window-drag={Boolean(onTitlePointerDown) || undefined}>
        <span className="kd-truncate">{title}</span>
        {titleExtra}
        {onClose && <button type="button" className="kd-pip-float-x" aria-label={closeLabel}
          onClick={e => { e.stopPropagation(); onClose(); }}><X size={13} /></button>}
      </div>}
      <div className="kd-pip-float-bottom">
        <button type="button" aria-label={playing ? "暂停" : "播放"} aria-busy={loading}
          onClick={e => { e.stopPropagation(); onToggle(); }}>
          {loading ? <LoaderCircle size={13} className="kd-spin" /> : playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        </button>
        <span className="kd-mono">{formatDuration(position)} / {formatDuration(duration)}</span>
        <button type="button" aria-label={fullscreen ? "退出全屏" : "全屏播放"} aria-pressed={fullscreen}
          title={fullscreen ? "退出全屏（Esc）" : "全屏播放"}
          onClick={e => { e.stopPropagation(); onFullscreen(); }}>
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {showVolume && <PreviewVolume channel={volumeChannel} />}
        {extra}
      </div>
      {error && <div className="kd-pip-float-error">{error}</div>}
    </div>
  </>;
}

export function FloatingVideoScrub({ position, duration, ...props }: HTMLAttributes<HTMLDivElement> & {position: number; duration: number}) {
  return <div className="kd-pip-float-scrub" role="slider" tabIndex={0} aria-label="视频进度"
    aria-valuemin={0} aria-valuemax={duration} aria-valuenow={position} {...props}>
    <span className="kd-pip-float-scrub-fill" style={{width: `${duration > 0 ? Math.min(100, Math.max(0, position / duration * 100)) : 0}%`}} />
  </div>;
}
