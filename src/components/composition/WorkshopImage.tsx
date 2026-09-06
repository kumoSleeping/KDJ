import { useEffect, useRef } from "react";
import type { CompositionProject, WorkshopClip, WorkshopSource } from "../../types/workshop";
import type { WorkshopPlayback } from "../../lib/workshopPlayback";
import { useWorkshopStore } from "../../stores/workshopStore";
import { acquireCoverThumbnail } from "../../lib/coverThumbnailQueue";
import { api } from "../../lib/api";
import { clipDuration, fadeAlpha, imageTime } from "../../lib/workshop";
import { gifFrame, pictureBox } from "../../lib/workshopPicture";

export function WorkshopImage({ project, clip, source, playback, inspect, zIndex, onError, onReady }: {
  project: CompositionProject; clip: WorkshopClip; source: WorkshopSource;
  onError(message:string):void; onReady():void;
  playback: WorkshopPlayback; inspect?: "in" | "out"; zIndex: number;
}) {
  const root = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const position = useWorkshopStore(s => s.position);
  const latest = useRef({project, clip, source, playback, inspect, onError, onReady}); latest.current = {project, clip, source, playback, inspect, onError, onReady};
  const wake = useRef<() => void>(() => {});
  const c = inspect ? {...clip, picture: {x:.5,y:.5,scale:1,opacity:1}} : clip;
  const b = pictureBox(project, c, source);
  useEffect(() => {
    let alive = true, raf = 0, wanted = "", displayed = "", lastError = "";
    const leases = new Map<string, {url?: string; error?: string; release(): void}>();
    const schedule = () => { if (!raf && alive && !document.hidden) raf = requestAnimationFrame(tick); };
    const tick = () => {
      raf = 0; if (!alive || !root.current || !image.current) return;
      const {project:p,clip:c,source:s,playback:pb,inspect} = latest.current;
      const state = useWorkshopStore.getState();
      const playing = pb.playing && !inspect && !state.scrubbing && !state.gesture;
      const time = playing ? pb.time() : state.position;
      const local = inspect === "out" ? Math.max(0,clipDuration(c)-1000/p.canvas.fps) : inspect ? 0 : time-c.start_ms;
      const visible = Boolean(inspect) || local >= 0 && local < clipDuration(c);
      root.current.style.opacity = String(visible ? inspect ? 1 : c.picture.opacity * fadeAlpha(c, local) : 0);
      const frame = gifFrame(s.frame_ends_ms, imageTime(c,local));
      wanted = api.workshopFrameUrl(p.id,s.id,frame.ms,960);
      const urls = [wanted];
      if (playing && s.kind === "gif" && s.frame_ends_ms?.length) {
        for (let i=1;i<=2;i++) { const index=(frame.index+i)%s.frame_ends_ms.length; urls.push(api.workshopFrameUrl(p.id,s.id,index ? s.frame_ends_ms[index-1] : 0,960)); }
      }
      for (const url of urls) if (!leases.has(url)) {
        const lease = acquireCoverThumbnail(`vj-image:${url}`, url, 0); const entry: {release():void;url?:string;error?:string} = {release:lease.release}; leases.set(url,entry);
        void lease.promise.then(src => { if (alive && leases.get(url) === entry) { entry.url=src; schedule(); } }).catch(() => { if (alive && leases.get(url) === entry) {entry.error=`${s.title} 无法预览`;schedule();} });
      }
      const failure=leases.get(wanted)?.error;
      if(failure && failure !== lastError) {lastError=failure;latest.current.onError(failure);}
      const ready = leases.get(wanted)?.url;
      if (ready) { const changed=displayed!==wanted; if(image.current.getAttribute("src") !== ready) image.current.src=ready; displayed=wanted; root.current.style.visibility="visible"; if(lastError || changed) {lastError="";latest.current.onReady();} }
      else if (!playing) root.current.style.visibility="hidden";
      for (const [url,lease] of leases) if (!urls.includes(url) && url !== displayed) {lease.release(); leases.delete(url);}
      if (playing) schedule();
    };
    wake.current=schedule; schedule();
    document.addEventListener("visibilitychange",schedule);
    return () => {alive=false;cancelAnimationFrame(raf);wake.current=()=>{};document.removeEventListener("visibilitychange",schedule);for(const lease of leases.values()) lease.release();};
  }, [project.id, source.signature]);
  useEffect(() => {wake.current();}, [project,clip,position,inspect,playback.playing]);
  return <div ref={root} className="vj-image-picture" style={{zIndex,left:`${b.x*100}%`,top:`${b.y*100}%`,width:`${b.width*100}%`,height:`${b.height*100}%`,transform:`rotate(${b.rotation}deg)`}}>
    <div style={{position:"absolute",inset:0,overflow:"hidden",transform:`scale(${c.picture.flip_x ? -1:1},${c.picture.flip_y ? -1:1})`}}>
      <img ref={image} draggable={false} alt="" style={{position:"absolute",maxWidth:"none",width:`${source.width/b.sw*100}%`,height:`${source.height/b.sh*100}%`,left:`${-b.left/b.sw*100}%`,top:`${-b.top/b.sh*100}%`}} />
    </div>
  </div>;
}
