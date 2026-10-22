/**
 * The editor of a `.kdjv` 2 project (docs/kdjv.md, "格式 2"; LaneEditor.tsx), a drawer app. It
 * holds the document as the server last saved it: every change is a list of operations sent to
 * `/api/kdjv/edit`, which checks the result as playing it would and only then writes it, so what
 * is shown here is always what is on disk. The project plays as a library row like any other; its
 * picture is the video window's (KdjvLivePicture), refreshed after each edit.
 */
import { create } from "zustand";
import { api } from "../lib/api";
import { useKdjvLive } from "../lib/kdjvPlay";
import type { LaneDocument, LaneEdited, LaneLayout, LaneOp } from "../lib/lanes";
import { getPlayerSession } from "../lib/playerSession";
import { playTrack } from "../lib/playTrack";
import type { Track } from "../types";

export const LANE_EDITOR_APP = "lane-editor";

/** The song's bar lines and beats (seconds of the song) and where the project starts in it. */
export interface LaneGrid { downbeats: number[]; beats: number[]; songIn: number }

/** How long a song's beat grid is waited for while it is analysed, polled this often. */
const GRID_WAIT_MS = 180_000;
const GRID_POLL_MS = 2_000;

interface LaneEditorState {
  open: boolean;
  path: string | null;
  trackId: number | null;
  doc: LaneDocument | null;
  layout: LaneLayout | null;
  grid: LaneGrid | null;
  /** The id of the clip being edited. */
  selected: string | null;
  /** The song's beat grid is being analysed. */
  analysing: boolean;
  busy: boolean;
  error: string | null;
  openTrack(track: Pick<Track, "id" | "path">): Promise<void>;
  startVj(song: Track): Promise<void>;
  startVideo(video: Track): Promise<void>;
  /** Sends the operations; false when they were refused (the reason is in `error`). */
  edit(ops: LaneOp[]): Promise<boolean>;
  select(id: string | null): void;
  close(): void;
}

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const separator = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
const cleanName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_").trim() || "工程";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useLaneEditor = create<LaneEditorState>((set, get) => {
  /** What came back from the server becomes the editor's state; the grid is read once per song. */
  const adopt = async (edited: LaneEdited) => {
    const before = get();
    set({
      open: true, path: edited.path, trackId: edited.track_id, doc: edited.document, layout: edited.layout,
      busy: false, error: null,
      selected: before.selected && edited.document.main.some(item => "id" in item && item.id === before.selected) ? before.selected : null,
    });
    const songId = edited.song_track_id;
    if (!edited.document.song || songId === null) {
      set({ grid: null, analysing: false });
    } else if (before.doc?.song?.src !== edited.document.song.src || !before.grid) {
      void loadGrid(songId, edited.document.song.src, edited.document.song.in ?? 0);
    }
    void refreshPlaying(edited);
  };

  /** The song's whole beat grid, analysed now when it has none yet (bar lines through every tempo change). */
  const loadGrid = async (songId: number, src: string, songIn: number) => {
    const current = () => get().doc?.song?.src === src;
    let reply = await api.rhythm(songId).catch(() => null);
    if (!reply?.analysis) {
      set({ analysing: true });
      await api.startRhythm(songId, true).catch(() => null);
      const until = Date.now() + GRID_WAIT_MS;
      while (!reply?.analysis && Date.now() < until && current()) {
        await new Promise(resolve => window.setTimeout(resolve, GRID_POLL_MS));
        reply = await api.rhythm(songId).catch(() => null);
      }
    }
    if (!current()) return;
    const analysis = reply?.analysis;
    set({ analysing: false, grid: { downbeats: analysis?.downbeats ?? [], beats: analysis?.beats ?? [], songIn } });
  };

  /** The project playing now shows the edit: a VJ's picture is swapped under its song; any other
   *  project is played again from where it was, its sound being mixed anew. */
  const refreshPlaying = async (edited: LaneEdited) => {
    const id = edited.track_id;
    const session = getPlayerSession();
    if (id === null || session.trackId !== id) return;
    if (edited.document.song) {
      const preview = await api.previewKdjv(id).catch(() => null);
      if (preview && !preview.render) useKdjvLive.setState(({ live }) => ({ live: { ...live, [id]: preview.project } }));
      return;
    }
    const track = await api.track(id).catch(() => null);
    if (track) playTrack(track, session.playing, undefined, session.position);
  };

  /** A new project beside `beside`, named after it; a name already taken gets a number. */
  const create = async (beside: string, name: string, ops: LaneOp[]) => {
    set({ busy: true, error: null, open: true });
    const folder = folderOf(beside);
    for (let n = 1; n <= 20; n++) {
      const path = `${folder}${separator(beside)}${cleanName(n === 1 ? name : `${name} ${n}`)}.kdjv`;
      try {
        await adopt(await api.editKdjv({ path, ops, create: true }));
        return;
      } catch (error) {
        if (!message(error).includes("已经有这个文件")) {
          set({ busy: false, error: message(error) });
          return;
        }
      }
    }
    set({ busy: false, error: "这个文件夹里同名的工程太多了" });
  };

  return {
    open: false, path: null, trackId: null, doc: null, layout: null, grid: null, selected: null, analysing: false, busy: false, error: null,
    async openTrack(track) {
      set({ open: true, busy: true, error: null, selected: null, doc: null, layout: null, grid: null, path: track.path, trackId: track.id });
      try {
        await adopt(await api.editKdjv({ track_id: track.id, ops: [] }));
      } catch (error) {
        set({ busy: false, error: message(error) });
      }
    },
    async startVj(song) {
      if (!song.duration) {
        set({ open: true, error: "这首歌还读不到时长，等曲库读完再试" });
        return;
      }
      await create(song.path, `${song.title || "未命名"} VJ`, [
        { op: "new", title: `${song.title || "未命名"} VJ`, song: { src: song.path, in: 0, out: song.duration } },
      ]);
    },
    async startVideo(video) {
      if (!video.duration) {
        set({ open: true, error: "这个视频还读不到时长，等曲库读完再试" });
        return;
      }
      await create(video.path, `${video.title || "未命名"} 剪辑`, [
        { op: "new", title: `${video.title || "未命名"} 剪辑` },
        { op: "add", clip: { src: video.path, in: 0, out: video.duration, fill: true } },
      ]);
    },
    async edit(ops) {
      const { path, busy } = get();
      if (!path || busy) return false;
      set({ busy: true, error: null });
      try {
        await adopt(await api.editKdjv({ path, ops }));
        return true;
      } catch (error) {
        set({ busy: false, error: message(error) });
        return false;
      }
    },
    select: id => set({ selected: id }),
    close: () => set({ open: false, selected: null, error: null }),
  };
});
