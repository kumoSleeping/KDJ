import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Music2, X } from "lucide-react";
import { api } from "../../lib/api";
import { announceAudioFocus } from "../../lib/audioFocus";
import { sourceKey, type SongPreviewRequest } from "../../lib/songPreview";
import { Button, InlineNotice } from "../common";

export function SongPreviewPanel({ request, onClose }: { request: SongPreviewRequest; onClose: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setUrl("");
    setError("");
    void api.songPreview(request.source).then(({ url: next }) => {
      if (alive) setUrl(next);
    }).catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, [request]);
  return (
    <section className="kd-song-preview">
      <div className="kd-toolbar" data-slim="true">
        <Music2 size={14} /><strong className="kd-nowrap">歌曲预览</strong>
        <span className="kd-truncate kd-muted">{request.title} · {request.artist || "未知艺人"}</span>
        <span className="kd-toolbar-gap" />
        <Button variant="ghost" size="sm" iconOnly aria-label="关闭预览" onClick={onClose}><X size={12} /></Button>
      </div>
      <div className="kd-song-preview-body">
        <strong className="kd-truncate">{request.title}</strong>
        <span className="kd-muted kd-truncate">{request.artist || "未知艺人"}</span>
        {url ? <audio ref={audioRef} controls autoPlay src={url} onPlay={() => announceAudioFocus("song")} /> : <LoaderCircle className="kd-spin" size={18} />}
        <InlineNotice text={error} />
        <span className="kd-faint kd-size-xs">来源：{sourceKey(request.source)}</span>
      </div>
    </section>
  );
}
