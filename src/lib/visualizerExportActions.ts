import { showTask } from "../components/tasks/taskBubbleStore";
import type { TrackSummary } from "../types";
import { api, visualizerApi } from "./api";
import { canVisualizeTrack } from "./visualizerPopup";
import { createVisualizerProject, loadVisualizerDraft, syncVisualizerImages, studioLyricText, hasStudioLyrics, STUDIO_IMAGE_LIMIT, type VisualizerDraft } from "./visualizerStudio";
import { applyVisualizerPreferences, loadVisualizerPreferences } from "./visualizerStudioPreferences";
import { tossToDownloads, type TossRequest } from "./downloadToss";
import { useVisualizerExportStore } from "../stores/visualizerExportStore";
import { checkVisualizerExportSupport } from "./visualizerExportSupport";

const editors = new Map<number, () => VisualizerDraft | null>();

/** Read the live editor before its autosave, without handing the queue mutable state. */
export function registerVisualizerDraft(id: number, read: () => VisualizerDraft | null): () => void {
  editors.set(id, read);
  return () => { if (editors.get(id) === read) editors.delete(id); };
}

export function reportVisualizerExportError(error: unknown): void {
  showTask({ id: "visualizer-export-error", kind: "export", title: "加入导出队列失败",
    detail: error instanceof Error ? error.message : String(error), tone: "error" });
}

export async function exportVisualizerTracks(tracks: TrackSummary[], from?: TossRequest["from"]): Promise<void> {
  if (!tracks.length) return;
  if (tracks.some(track => !canVisualizeTrack(track))) throw new Error("仅支持本地音频的可视化导出");
  const blocked = await checkVisualizerExportSupport();
  if (blocked) throw new Error(blocked);
  const toss = tossToDownloads({ to: "exports", from, title: tracks[0].title, count: tracks.length });
  try {
    for (const track of tracks) {
      const live = editors.get(track.id)?.();
      let draft: VisualizerDraft | undefined = live
        ? { project: structuredClone(live.project), images: [...live.images] }
        : await loadVisualizerDraft(track.id);
      if (!draft) {
        const project = createVisualizerProject(track);
        const [cover, lyrics] = await Promise.all([
          visualizerApi.cover(track.id),
          api.libraryLyrics(track.id).catch(() => null),
        ]);
        const images = cover && cover.size <= STUDIO_IMAGE_LIMIT ? [cover] : [];
        syncVisualizerImages(project, images.length);
        if (lyrics) {
          project.lyrics.lrc = studioLyricText(lyrics.lrc || "", lyrics.word_lrc);
          project.lyrics.translation = lyrics.translated_lrc || "";
          project.lyrics.mode = hasStudioLyrics(project.lyrics.lrc) ? "scroll" : "off";
        }
        draft = { project, images };
      }
      const preferences = loadVisualizerPreferences(draft.project);
      if (!live && preferences) applyVisualizerPreferences(draft.project, preferences);
      await toss.ready;
      await useVisualizerExportStore.getState().enqueue(draft);
    }
  } catch (error) { toss.fail(); throw error; }
}
