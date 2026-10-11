import { useEffect } from "react";
import { Maximize2, Minimize2, Pin, PinOff } from "lucide-react";
import {
  MINI_PLAYER_BUBBLE,
  collapseToMiniPlayer,
  expandFromMiniPlayer,
  fitMiniPlayer,
  miniPlayerOffered,
  setMiniPlayerOnTop,
  syncMiniPlayer,
  useMiniPlayer,
} from "../../lib/miniPlayer";
import "./MiniPlayer.css";

/** How often the window is checked against the bubble, and how long a bubble may be missing. */
const FIT_EVERY_MS = 200;
const MISSING_MS = 1600;
/** What a press on the bubble belongs to instead of moving the window. */
const NOT_A_HANDLE = "button, a, input, select, textarea, [role='slider'], .kd-task-controls";

/**
 * The mini player's keys, in the tool row of the playing song's bubble (docs/task-bubbles.md).
 * In the whole window: the key that takes the window down to the bubble. As the mini player:
 * whether it floats over other windows, and the way back.
 */
export function MiniPlayerKeys() {
  const phase = useMiniPlayer(state => state.phase);
  const onTop = useMiniPlayer(state => state.onTop);
  if (!miniPlayerOffered()) return null;
  if (phase !== "on") {
    return <button type="button" className="kd-task-action kd-mini-key" data-task-action="mini"
      aria-label="收成迷你播放器" title="收成迷你播放器" disabled={phase !== "off"}
      onClick={() => { void collapseToMiniPlayer(); }}>
      <Minimize2 size={14} aria-hidden="true" />
    </button>;
  }
  const floats = onTop ? "置顶：开。点一下不再浮在其他窗口上面" : "置顶：关。点一下浮在其他窗口上面";
  return <>
    <button type="button" className="kd-task-action kd-mini-key" data-task-action="mini-top"
      aria-label={onTop ? "取消置顶" : "置顶"} title={floats} aria-pressed={onTop}
      onClick={() => { void setMiniPlayerOnTop(!onTop); }}>
      {onTop ? <Pin size={14} aria-hidden="true" /> : <PinOff size={14} aria-hidden="true" />}
    </button>
    <button type="button" className="kd-task-action kd-mini-key" data-task-action="mini"
      aria-label="展开窗口" title="展开窗口" onClick={() => { void expandFromMiniPlayer(); }}>
      <Maximize2 size={14} aria-hidden="true" />
    </button>
  </>;
}

/**
 * What the mini player needs of the page while it lasts: the bubble is the window's handle,
 * the window keeps the bubble's height, Esc does not roll the only thing on screen away, and
 * a window left without a song to show is given back.
 */
export function MiniPlayerHost() {
  const on = useMiniPlayer(state => state.phase === "on");
  useEffect(() => { void syncMiniPlayer(); }, []);
  useEffect(() => {
    if (!on) return;
    const drag = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (!event.target.closest(MINI_PLAYER_BUBBLE) || event.target.closest(NOT_A_HANDLE)) return;
      window.kdj?.windowControl("drag");
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
    };
    let missingSince = 0;
    const fit = window.setInterval(() => {
      if (fitMiniPlayer()) { missingSince = 0; return; }
      missingSince ||= performance.now();
      if (performance.now() - missingSince > MISSING_MS) void expandFromMiniPlayer();
    }, FIT_EVERY_MS);
    document.addEventListener("pointerdown", drag);
    window.addEventListener("keydown", key, true);
    return () => {
      window.clearInterval(fit);
      document.removeEventListener("pointerdown", drag);
      window.removeEventListener("keydown", key, true);
    };
  }, [on]);
  return null;
}
