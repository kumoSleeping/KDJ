// `kdj visualizer render`: the server asks the windows (the main one too while it is hidden,
// `--no-gui`) to render a song's visualizer, and the first one to claim it exports the
// studio's default project with the song's cover through the studio's own exporter
// (WebCodecs). A window that cannot export claims it all the same and answers why.
import { api, visualizerApi } from "./api";
import { mediaProductionAvailable } from "./platformFeatures";
import { checkVisualizerExportSupport } from "./visualizerExportSupport";
import { createVisualizerProject, studioDuration, syncVisualizerImages } from "./visualizerStudio";
import { runStudioExport } from "./visualizerStudioExport";

export interface VisualizerCliRender { id: string; track_id: number; output_path: string; width?: number | null; height?: number | null }

export async function renderForCli(request: VisualizerCliRender): Promise<void> {
  if (!mediaProductionAvailable()) return;
  if (!(await visualizerApi.claimCliRender(request.id).catch(() => ({ claimed: false }))).claimed) return;
  try {
    const blocked = await checkVisualizerExportSupport();
    if (blocked) throw new Error(blocked);
    const [track, cover] = await Promise.all([api.track(request.track_id), visualizerApi.cover(request.track_id)]);
    if (!cover) throw new Error("这首歌没有内嵌封面，可视化需要一张图片");
    const project = createVisualizerProject(track);
    syncVisualizerImages(project, 1);
    const canvas = project.scene.canvas;
    project.scene.canvas = { ...canvas, width: request.width ?? canvas.width, height: request.height ?? canvas.height };
    const status = await runStudioExport({ project, images: [cover] }, request.output_path, new AbortController().signal, () => undefined);
    if (status.phase !== "done") throw new Error(status.error || "可视化导出没有完成");
    // What the CLI reports.
    const { width, height } = project.scene.canvas;
    const analysis = await visualizerApi.analyze(track.id, project.scene.spectrum);
    await visualizerApi.finishCliRender(request.id, { report: { path: status.output_path, duration: studioDuration(analysis.timeline), width, height, fps: project.output.fps } });
  } catch (error) {
    await visualizerApi.finishCliRender(request.id, { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  }
}
