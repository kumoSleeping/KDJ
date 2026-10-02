import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LiveVjStandby } from "../../lib/liveVj";
import { VideoPlaybackEngine } from "../../lib/videoPlaybackEngine";
import { waitForVideoFrames } from "../../lib/videoFrames";
function Picture({asset, visible, playing, ready, failure}: {asset: LiveVjStandby; visible: boolean; playing: boolean; ready(): void; failure(error: string): void}) {
  const video = useRef<HTMLVideoElement>(null);
  const engine = useMemo(() => new VideoPlaybackEngine(), []);
  const latest = useRef({visible: playing, ready, failure}); latest.current = {visible: playing, ready, failure};
  const source = convertFileSrc(asset.path);
  useEffect(() => {
    const media = video.current; if (!media) return;
    const abort = new AbortController(); let prepared = false;
    const fail = (error: unknown) => { if (!abort.signal.aborted) latest.current.failure(`默认视频无法播放：${String(error)}`); };
    const loop = async () => {
      if (!latest.current.visible || abort.signal.aborted) return;
      if (await engine.seek(media, 0) && !abort.signal.aborted && latest.current.visible) await media.play();
    };
    const ended = () => { void loop().catch(fail); };
    const loaded = async () => {
      if (prepared || abort.signal.aborted) return;
      engine.setBaseRate(media, 1);
      await media.play();
      if (await waitForVideoFrames(media, media.currentTime, false, abort.signal, 3000)) {
        prepared = true; latest.current.ready();
        if (!latest.current.visible) media.pause();
      } else if (!abort.signal.aborted) fail("解码画面未就绪");
    };
    const metadata = () => { void loaded().catch(fail); };
    media.addEventListener("loadedmetadata", metadata); media.addEventListener("ended", ended);
    // Match the live output: standby video must never compete with DJ audio.
    media.defaultMuted = true; media.muted = true; media.volume = 0;
    media.src = source; media.load();
    return () => { abort.abort(); engine.dispose(); media.removeEventListener("loadedmetadata", metadata); media.removeEventListener("ended", ended); media.pause(); media.removeAttribute("src"); media.load(); };
  }, [source, engine]);
  useEffect(() => {
    const media = video.current; if (!media || media.readyState < 2) return;
    let alive = true;
    if (!playing) media.pause();
    else void (async () => {
      if (media.ended && !await engine.seek(media, 0)) return;
      if (alive) await media.play();
    })().catch(e => { if (alive) latest.current.failure(String(e)); });
    return () => { alive = false; };
  }, [playing, engine]);
  return <div className="kd-live-vj-standby-picture" style={{opacity: visible ? 1 : asset.kind === "video" ? 0.001 : 0}}>
    {asset.kind === "video" ? <video ref={video} muted playsInline preload="auto" onError={() => latest.current.failure("默认视频无法解码")}/>
      : <img src={source} alt="" onLoad={() => latest.current.ready()} onError={() => latest.current.failure("默认图片无法读取")}/>}
  </div>;
}
export function LiveVjStandby({asset, visible, failure}: {asset: LiveVjStandby | null; visible: boolean; failure(error: string): void}) {
  const [front, setFront] = useState<LiveVjStandby | null>(null);
  const desired = useRef(asset); desired.current = asset;
  useEffect(() => { if (!asset) setFront(null); }, [asset?.path]);
  if (!asset) return null;
  const layers = front && front.path !== asset.path ? [front, asset] : [asset];
  return <div className="kd-live-vj-standby" aria-hidden="true">{layers.map(item => <Picture key={item.path} asset={item}
    visible={front?.path === item.path} playing={visible && front?.path === item.path}
    ready={() => { if (desired.current?.path === item.path) { setFront(item); failure(""); } }}
    failure={failure}/>)}</div>;
}
