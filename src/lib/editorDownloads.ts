/**
 * Online songs and videos dropped into the editor (its lanes, or its title row for a new project):
 * downloaded into the default download folder like any other download — the parcel flies to the
 * downloads and the queue shows them — and put into the project where they were let go once the
 * library has them (laneEditorStore `placeTracks`). Meanwhile the lane shows where each will go and
 * how far along it is; a download that fails or is cancelled leaves nothing behind but its reason.
 */
import { create } from "zustand";
import { api } from "./api";
import { withDownloadDisplay } from "./downloadDisplay";
import { tossToDownloads } from "./downloadToss";
import { rememberVideoEnqueue } from "./queueTaskDraft";
import { LANE_END } from "./lanes";
import type { ActiveSearchDrag } from "./searchDrag";
import { useAppStore } from "../stores/appStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useLaneEditor } from "../stores/laneEditorStore";
import type { DownloadTask, Track } from "../types";

export interface EditorDownload {
  /** The download task. */
  task: string;
  /** The project it goes into; null starts a new one. */
  path: string | null;
  lane: "song" | "main";
  /** Where it was let go, in seconds of the project. */
  at: number;
  title: string;
  /** Downloads of one drop go in one after another, in the order they were dragged. */
  drop: number;
  order: number;
  /** Being put in now. */
  placing?: boolean;
}

export const useEditorDownloads = create<{ pending: EditorDownload[] }>(() => ({ pending: [] }));

let drops = 0;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Downloads what was dropped and remembers where it goes. */
export async function downloadIntoEditor(payload: ActiveSearchDrag, path: string | null, at: number, sound = false): Promise<void> {
  watchEditorDownloads();
  const settings = useAppStore.getState().settings;
  const folder = settings?.download_dir?.trim() || "";
  const editor = useLaneEditor.getState();
  if (!folder) { editor.fail("还没有设置默认下载文件夹"); return; }
  if (payload.kind === "audio" && payload.sources.length === 0) return;
  const drop = ++drops;
  // The editor stays where it is; the parcel aims at the 下载 entry.
  const toss = tossToDownloads({
    title: payload.kind === "video" ? payload.title : payload.sources[0]?.title,
    cover: payload.kind === "video" ? payload.cover : payload.sources[0]?.cover,
    count: payload.kind === "video" ? 1 : payload.sources.length,
    open: false,
  });
  await toss.ready;
  const downloads = useDownloadStore.getState();
  try {
    if (payload.kind === "video") {
      const title = payload.title?.trim() || payload.request.bvid?.trim() || "视频";
      const request = { ...payload.request, dest_dir: folder, follow_default_dir: true, title, artist: payload.artist, cover: payload.cover };
      const task = await api.videoDownload(request);
      rememberVideoEnqueue(task.id, request);
      downloads.mergeTasks([withDownloadDisplay(task, { title, artist: payload.artist, cover: payload.cover, dest_dir: folder })]);
      remember([{ task: task.id, path, lane: sound || payload.request.audio_only ? "song" : "main", at, title, drop, order: 0 }]);
      return;
    }
    const tasks = await downloads.enqueue(payload.sources, { quality: settings?.default_quality ?? null, dest_dir: folder, follow_default_dir: true });
    downloads.mergeTasks(tasks.map((task, n) => withDownloadDisplay(task, {
      title: payload.sources[n]?.title, artist: payload.sources[n]?.artists?.filter(Boolean).join(", "),
      cover: payload.sources[n]?.cover, dest_dir: folder,
    })));
    remember(tasks.map((task, n) => ({ task: task.id, path, lane: "song" as const, at, title: payload.sources[n]?.title || task.title, drop, order: n })));
  } catch (error) {
    toss.fail();
    editor.fail(message(error));
  }
}

function remember(items: EditorDownload[]): void {
  useEditorDownloads.setState(({ pending }) => ({ pending: [...pending, ...items] }));
  // A task that was already done (a file downloaded before) is put in at once.
  settle(useDownloadStore.getState().tasks);
}

/** Puts in what has finished, in drop order; forgets what failed. */
function settle(tasks: Map<string, DownloadTask>): void {
  const { pending } = useEditorDownloads.getState();
  for (const item of pending) {
    const task = tasks.get(item.task);
    if (!task || item.placing) continue;
    if (task.state === "failed" || task.state === "canceled") {
      forget(item);
      if (task.state === "failed") useLaneEditor.getState().fail(`「${item.title}」没下载下来：${task.error || "下载失败"}`);
      continue;
    }
    if (task.state !== "done") continue;
    // Downloads of one drop go in in the order they were dragged: one waits for those before it.
    if (pending.some(other => other.drop === item.drop && other.order < item.order)) continue;
    update(item, { placing: true });
    void place(item, task).finally(() => {
      forget(item);
      settle(useDownloadStore.getState().tasks);
    });
  }
}

function update(item: EditorDownload, change: Partial<EditorDownload>): void {
  Object.assign(item, change);
  useEditorDownloads.setState(({ pending }) => ({ pending: [...pending] }));
}

function forget(item: EditorDownload): void {
  useEditorDownloads.setState(({ pending }) => ({ pending: pending.filter(other => other !== item) }));
}

async function place(item: EditorDownload, task: DownloadTask): Promise<void> {
  const editor = useLaneEditor.getState();
  const track: Track | null = task.track_id === null ? null : await api.track(task.track_id).catch(() => null);
  if (!track) { editor.fail(`「${item.title}」下载好了，曲库里还没有它`); return; }
  // The project it was dropped into comes back as a page if it was closed meanwhile.
  if (item.path && !editor.projects.some(p => p.path === item.path) && !(await editor.openPath(item.path))) return;
  const project = item.path ? useLaneEditor.getState().projects.find(p => p.path === item.path) : undefined;
  const songs = project?.layout.songs ?? [];
  const slot = songs.filter(s => s.at + s.length / 2 < item.at).length;
  await editor.placeTracks(project ? project.path : null, [track], item.at, item.lane === "song");
  // The rest of the drop goes after it: into the project it went into (or started), past it.
  const into = project ? project.path : useLaneEditor.getState().active;
  const now = useLaneEditor.getState().projects.find(p => p.path === into)?.layout.songs ?? [];
  const placed = now[project ? slot : 0];
  const next = item.lane === "song" && placed ? placed.at + placed.length : LANE_END;
  for (const other of useEditorDownloads.getState().pending) {
    if (other !== item && other.drop === item.drop) update(other, { path: into, at: next });
  }
}

let watching = false;
/** Starts following the downloads (once, with the first drop). */
function watchEditorDownloads(): void {
  if (watching) return;
  watching = true;
  useDownloadStore.subscribe((state, previous) => {
    if (state.tasks !== previous.tasks && useEditorDownloads.getState().pending.length) settle(state.tasks);
  });
}
