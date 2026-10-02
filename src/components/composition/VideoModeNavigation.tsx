import { BarChart3, Clapperboard, Radio } from "lucide-react";

type VideoMode = "workshop" | "visualizer" | "live-vj";

export function VideoModeNavigation({ active, onSelect }: { active: VideoMode; onSelect: (mode: VideoMode) => void }) {
  return <nav className="kd-video-modes" aria-label="视频工作模式">
    {([
      { mode: "workshop", label: "视频项目", icon: Clapperboard },
      { mode: "visualizer", label: "可视化", icon: BarChart3 },
      { mode: "live-vj", label: "自动 VJ", icon: Radio },
    ] as const).map(({ mode, label, icon: Icon }) => <button key={mode} type="button"
      aria-current={active === mode ? "page" : undefined}
      disabled={mode === "live-vj" && !["darwin", "win32", "linux"].includes(window.kdj?.platform ?? "")}
      onClick={() => onSelect(mode)}><Icon size={20} aria-hidden="true"/><span>{label}</span></button>)}
  </nav>;
}
