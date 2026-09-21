import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { api } from "../../lib/api";
import { findClip } from "../../lib/workshop";
import { useLibraryStore } from "../../stores/libraryStore";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { useWorkshopStore } from "../../stores/workshopStore";

export function WorkshopVisualizerAction({ editing = false }: { editing?: boolean }) {
  const project = useWorkshopStore(s => s.draft);
  const clipId = useWorkshopStore(s => s.selectedId);
  const libraryId = useLibraryStore(s => s.selectedId);
  const [loading, setLoading] = useState(false);
  const clip = editing && project ? findClip(project, clipId) : null;
  const source = clip && project?.sources.find(s => s.id === clip.source_id && s.audio && s.track_id > 0);
  const trackId = source ? source.track_id : libraryId !== null && libraryId > 0 ? libraryId : null;
  return <button type="button" aria-label="音频可视化" disabled={trackId === null || loading}
    title={source ? `音频可视化 · ${source.title}` : "将曲库选中歌曲生成可视化视频"}
    onClick={() => {
      if (trackId === null || loading) return;
      setLoading(true);
      void api.track(trackId).then(track => useVisualizerStudioStore.getState().open(track))
        .catch(error => useWorkshopStore.setState({ error: `打开可视化失败：${error instanceof Error ? error.message : String(error)}` }))
        .finally(() => setLoading(false));
    }}><BarChart3 size={14} />可视化</button>;
}
