import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useLyricsPresentation, type LyricsExtent } from "../../lib/lyricsPresentation";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { useNowPlayingInfo } from "../../lib/nowPlayingInfo";
import { ContextMenu } from "../common/ContextMenu";

export function LyricsPresentation({ children }: { children: ReactNode }) {
  const extent = useLyricsPresentation(state => state.extent);
  const { tall } = useLayoutSignals();
  const fullscreen = extent === "fullscreen" && tall;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const cancel = () => { if (press.current !== null) clearTimeout(press.current); press.current = null; };
  useEffect(() => () => cancel(), []);
  useEffect(() => {
    if (!fullscreen) return;
    const root = document.documentElement;
    root.dataset.lyricsFullscreen = "true";
    const wasOpen = useNowPlayingInfo.getState().open;
    useNowPlayingInfo.setState({ open: true });
    return () => {
      delete root.dataset.lyricsFullscreen;
      if (!wasOpen) useNowPlayingInfo.setState({ open: false });
    };
  }, [fullscreen]);
  return <div className="kd-lyrics-presentation" data-extent={fullscreen ? "fullscreen" : extent === "standard" ? "standard" : "long"} onContextMenu={event => {
    if ((event.target as HTMLElement).closest("[role=menu]")) return;
    event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY });
  }} onPointerDown={event => {
    if (event.pointerType === "mouse" || (event.target as HTMLElement).closest("input, .kd-lyrics-embedded-tools")) return;
    cancel(); origin.current = { x: event.clientX, y: event.clientY };
    press.current = setTimeout(() => { setMenu(origin.current); suppressClick.current = true; press.current = null; }, 480);
  }} onPointerMove={event => {
    if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancel();
  }} onPointerUp={cancel} onPointerCancel={cancel} onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
    {children}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)}>
      {([ ["standard", "标准"], ["long", "更长"], ["fullscreen", "全屏"] ] as [LyricsExtent, string][]).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={extent === value} onClick={() => {
          useLyricsPresentation.getState().setExtent(value); setMenu(null);
        }}><Check size={13} style={{ opacity: extent === value ? 1 : 0 }} />{label}</button>)}
    </ContextMenu>}
  </div>;
}
