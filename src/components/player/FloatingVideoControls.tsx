import type { HTMLAttributes, ReactNode } from "react";
import { Maximize2, Minimize2, Pause, Play, X } from "lucide-react";
import { formatDuration } from "../../lib/format";

/** Shared by local playback and the workshop. Chrome stays inside the picture. */
export function FloatingVideoControls({ title, playing, position, duration, fullscreen, onClose, onToggle, onFullscreen, extra, error, closeLabel = "关闭预览" }: {
  title: string; playing: boolean; position: number; duration: number; fullscreen: boolean;
  onClose?(): void; onToggle(): void; onFullscreen(): void; extra?: ReactNode; error?: string; closeLabel?: string;
}) {
  return <div className="kd-pip-float-chrome" title={title}>
    <div className="kd-pip-float-top">
      <span className="kd-truncate">{title}</span>
      {onClose && <button type="button" className="kd-pip-float-x" aria-label={closeLabel}
        onClick={e => { e.stopPropagation(); onClose(); }}><X size={13} /></button>}
    </div>
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
