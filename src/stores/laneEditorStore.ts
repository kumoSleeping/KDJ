/**
 * The editor of `.kdjv` 2 projects (docs/kdjv.md, "格式 2"; LaneEditor.tsx), a drawer app. Several
 * projects are open at once, one page of the drawer's title each. Each holds its document as the
 * server last saved it: every change is a list of operations sent to `/api/kdjv/edit`, which checks
 * the result as playing it would and only then writes it, so what is shown is always what is on
 * disk. A project plays as a library row like any other; its picture is the video window's
 * (KdjvLivePicture), refreshed after each edit.
 */
import { create } from "zustand";
import { api } from "../lib/api";
import { isImageTrack, isProjectTrack, isVideoTrack } from "../lib/format";
import { useKdjvLive } from "../lib/kdjvPlay";
import { alignedOps, isGap, type AlignPlan, type LaneClip, type LaneDocument, type LaneEdited, type LaneLayout, type LaneOp } from "../lib/lanes";
import { getPlayerSession } from "../lib/playerSession";
import { playTrack } from "../lib/playTrack";
import { useSidePanels } from "../lib/sidePanels";
import type { Track } from "../types";

export const LANE_EDITOR_APP = "lane-editor";

/** Bar lines and beats in seconds of the project, through every song of the song lane. */
export interface LaneGrid { downbeats: number[]; beats: number[] }

/** One song's own grid, in seconds of the song; `precise` once the full analysis has answered. */
interface SongGrid { downbeats: number[]; beats: number[]; precise: boolean }

/** How often a song's full analysis is asked about, and for how long at most. */
const GRID_POLL_MS = 1_500;
const GRID_WAIT_MS = 15 * 60_000;

export interface LaneProject {
  path: string;
  trackId: number | null;
  /** Each song's library row (its bar lines), in the order of the song lane. */
  songIds: Array<number | null>;
  doc: LaneDocument;
  layout: LaneLayout;
  grid: LaneGrid | null;
  /** A song's full analysis is still under way; the grid shown is the library's quicker one meanwhile. */
  analysing: boolean;
}

interface LaneEditorState {
  open: boolean;
  projects: LaneProject[];
  /** The path of the project in view. */
  active: string | null;
  /** The id of the clip being edited. */
  selected: string | null;
  busy: boolean;
  error: string | null;
  /** Clips being found in their song (校准), by id. */
  aligning: string[];
  /** What 校准 found for a clip: its plans, best first, or none that fit. */
  plans: Record<string, AlignPlan[]>;
  /** Opens the drawer as it was (the key at the top right). */
  show(): void;
  openTrack(track: Pick<Track, "id" | "path">): Promise<void>;
  startVj(song: Track): Promise<void>;
  startVideo(video: Track): Promise<void>;
  /** A new project from what was dropped: the songs one after another (a VJ), else the videos. */
  createFrom(tracks: Track[]): Promise<void>;
  activate(path: string): void;
  /** Takes a project out of the editor (the file stays). */
  closeProject(path: string): void;
  /** Sends the operations to the project in view; false when they were refused (the reason is in `error`). */
  edit(ops: LaneOp[]): Promise<boolean>;
  select(id: string | null): void;
  close(): void;
  /** Finds where a clip of the project in view lies in the song under it; `auto` applies a sure plan at once. */
  calibrate(clipId: string, auto?: boolean): Promise<void>;
  applyPlan(clipId: string, plan: AlignPlan): Promise<void>;
}

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const separator = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
const cleanName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_").trim() || "工程";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A song for the song lane; a picture for the picture lane. Projects themselves are neither. */
export const isSongTrack = (track: Pick<Track, "format">) =>
  !isVideoTrack(track.format) && !isImageTrack(track.format) && !isProjectTrack(track.format);
export const isPictureTrack = (track: Pick<Track, "format">) => isVideoTrack(track.format) || isImageTrack(track.format);

export const songOf = (track: Track) => ({ src: track.path, in: 0, out: track.duration ?? 0 });
export const clipOf = (track: Track, muted: boolean) => ({ src: track.path, in: 0, out: track.duration ?? 0, muted, fill: true });

/** The songs of a document in order: `songs`, or the one `song`. */
export function songsOf(doc: LaneDocument) {
  return doc.songs ?? (doc.song ? [doc.song] : []);
}

/** Every song's grid, each moved to where that song plays in the project. */
function projectGrid(doc: LaneDocument, layout: LaneLayout, songIds: Array<number | null>): LaneGrid | null {
  const songs = layout.songs ?? [];
  if (songs.length === 0) return null;
  const grid: LaneGrid = { downbeats: [], beats: [] };
  songs.forEach((placed, n) => {
    const id = songIds[n];
    const own = id === null || id === undefined ? undefined : songGrids.get(id);
    if (!own) return;
    const from = placed.in ?? 0, to = from + placed.length;
    const move = (times: number[]) => times.filter(t => t >= from - 1e-3 && t < to - 1e-3).map(t => t - from + placed.at);
    grid.downbeats.push(...move(own.downbeats));
    grid.beats.push(...move(own.beats));
  });
  void doc;
  return grid;
}

/** Songs' grids already read this run, by library row. */
const songGrids = new Map<number, SongGrid>();
/** Songs whose full analysis is being waited for. */
const waiting = new Set<number>();

export const useLaneEditor = create<LaneEditorState>((set, get) => {
  const regrid = () => set(state => ({
    projects: state.projects.map(p => ({
      ...p,
      grid: projectGrid(p.doc, p.layout, p.songIds),
      analysing: p.songIds.some(id => id !== null && waiting.has(id)),
    })),
  }));

  /**
   * A song's grid: at once the one the library already has (its beat analysis), then the full
   * analysis's when it answers — read from the library if it was done before, else started now and
   * waited for, however long it takes, until it is there or has failed.
   */
  const loadSongGrid = async (songId: number) => {
    if (songGrids.get(songId)?.precise || waiting.has(songId)) return;
    if (!songGrids.has(songId)) {
      const track = await api.track(songId).catch(() => null);
      if (track?.beat_times?.length) {
        songGrids.set(songId, { downbeats: track.downbeats ?? [], beats: track.beat_times, precise: false });
        regrid();
      }
    }
    let reply = await api.rhythm(songId).catch(() => null);
    if (!reply?.analysis) {
      waiting.add(songId);
      regrid();
      await api.startRhythm(songId, true).catch(() => null);
      const until = Date.now() + GRID_WAIT_MS;
      while (!reply?.analysis && Date.now() < until) {
        await new Promise(resolve => window.setTimeout(resolve, GRID_POLL_MS));
        reply = await api.rhythm(songId).catch(() => null);
        const phase = reply?.status?.phase;
        if (phase === "failed" || phase === "canceled") break;
      }
      waiting.delete(songId);
    }
    const analysis = reply?.analysis;
    if (analysis) songGrids.set(songId, { downbeats: analysis.downbeats, beats: analysis.beats, precise: true });
    regrid();
  };

  /** What came back from the server becomes that project's state. */
  const adopt = (edited: LaneEdited) => {
    const songIds = edited.song_track_ids ?? (edited.song_track_id === null ? [] : [edited.song_track_id]);
    const project: LaneProject = {
      path: edited.path, trackId: edited.track_id, songIds, doc: edited.document, layout: edited.layout,
      grid: projectGrid(edited.document, edited.layout, songIds),
      analysing: songIds.some(id => id !== null && waiting.has(id)),
    };
    set(state => {
      const known = state.projects.some(p => p.path === project.path);
      const selected = state.active === project.path && state.selected
        && edited.document.main.some(item => "id" in item && item.id === state.selected) ? state.selected : null;
      return {
        open: true, busy: false, error: null, active: project.path, selected,
        projects: known ? state.projects.map(p => (p.path === project.path ? project : p)) : [...state.projects, project],
      };
    });
    for (const id of songIds) if (id !== null) void loadSongGrid(id);
    void refreshPlaying(edited);
  };

  /** The project playing now shows the edit: a VJ's picture is swapped under its songs; any other
   *  project is played again from where it was, its sound being mixed anew. */
  const refreshPlaying = async (edited: LaneEdited) => {
    const id = edited.track_id;
    const session = getPlayerSession();
    if (id === null || session.trackId !== id) return;
    if (songsOf(edited.document).length === 1) {
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
        adopt(await api.editKdjv({ path, ops, create: true }));
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
    open: false, projects: [], active: null, selected: null, busy: false, error: null, aligning: [], plans: {},
    show() {
      set({ open: true });
      useSidePanels.getState().raise(LANE_EDITOR_APP);
    },
    async openTrack(track) {
      const known = get().projects.find(p => p.path === track.path);
      if (known) { set({ open: true, active: known.path, selected: null }); return; }
      set({ open: true, busy: true, error: null, selected: null });
      try {
        adopt(await api.editKdjv({ track_id: track.id, ops: [] }));
      } catch (error) {
        set({ busy: false, error: message(error) });
      }
    },
    startVj: song => get().createFrom([song]),
    startVideo: video => get().createFrom([video]),
    async createFrom(tracks) {
      const missing = tracks.find(track => !(track.duration && track.duration > 0));
      if (missing) {
        set({ open: true, error: `「${missing.title || "未命名"}」还读不到时长，等曲库读完再试` });
        return;
      }
      const songs = tracks.filter(isSongTrack);
      const pictures = tracks.filter(isPictureTrack);
      if (songs.length) {
        const title = `${songs[0].title || "未命名"} VJ`;
        await create(songs[0].path, title, [
          { op: "new", title, song: songOf(songs[0]) },
          ...songs.slice(1).map(song => ({ op: "add_song" as const, song: songOf(song) })),
          ...fitPictures(pictures, songs.reduce((sum, song) => sum + (song.duration ?? 0), 0)),
        ]);
      } else if (pictures.length) {
        const title = `${pictures[0].title || "未命名"} 剪辑`;
        await create(pictures[0].path, title, [
          { op: "new", title },
          ...pictures.map(picture => ({ op: "add" as const, clip: clipOf(picture, false) })),
        ]);
      }
    },
    activate: path => set({ active: path, selected: null, error: null }),
    closeProject(path) {
      set(state => {
        const at = state.projects.findIndex(p => p.path === path);
        const projects = state.projects.filter(p => p.path !== path);
        const active = state.active !== path ? state.active : (projects[Math.min(at, projects.length - 1)]?.path ?? null);
        return { projects, active, selected: null, error: null };
      });
    },
    async edit(ops) {
      const { active, busy } = get();
      if (!active || busy) return false;
      set({ busy: true, error: null });
      try {
        adopt(await api.editKdjv({ path: active, ops }));
        return true;
      } catch (error) {
        set({ busy: false, error: message(error) });
        return false;
      }
    },
    select: id => set({ selected: id }),
    close: () => set({ open: false, selected: null, error: null }),
    async calibrate(clipId, auto = false) {
      const project = get().projects.find(p => p.path === get().active);
      const target = project && songUnder(project, clipId);
      if (!project || !target || get().aligning.includes(clipId)) return;
      const before = target.clip;
      set(state => ({ aligning: [...state.aligning, clipId], error: null }));
      try {
        const reply = await api.align(target.reference, before.src);
        set(state => ({ plans: { ...state.plans, [clipId]: reply.plans } }));
        const now = get().projects.find(p => p.path === project.path);
        const still = now?.doc.main.find((item): item is LaneClip => !isGap(item) && item.id === clipId);
        // A plan sure enough goes in by itself, unless the clip was changed meanwhile.
        if (auto && reply.plans[0]?.auto && still && still.in === before.in && still.out === before.out && get().active === project.path) {
          await get().applyPlan(clipId, reply.plans[0]);
        }
      } catch (error) {
        if (!auto) set({ error: message(error) });
      } finally {
        set(state => ({ aligning: state.aligning.filter(id => id !== clipId) }));
      }
    },
    async applyPlan(clipId, plan) {
      const project = get().projects.find(p => p.path === get().active);
      const target = project && songUnder(project, clipId);
      if (!target) return;
      const ops = alignedOps(target.clip, plan, target.song);
      if (ops.length && await get().edit(ops)) {
        set(state => {
          const { [clipId]: _gone, ...plans } = state.plans;
          return { plans, selected: null };
        });
      }
    },
  };
});

/** Pictures laid end to end from the start, as many as fit in `length` seconds. */
function fitPictures(pictures: Track[], length: number): LaneOp[] {
  const ops: LaneOp[] = [];
  let at = 0;
  for (const picture of pictures) {
    const out = Math.min(picture.duration ?? 0, length - at);
    if (out <= 0.05) break;
    ops.push({ op: "add", clip: { ...clipOf(picture, true), out } });
    at += out;
  }
  return ops;
}

/** A clip of the project with the song it starts over, and how to name that song to the aligner. */
function songUnder(project: LaneProject, clipId: string) {
  const clip = project.doc.main.find((item): item is LaneClip => !isGap(item) && item.id === clipId);
  const placed = project.layout.main.find(item => item.id === clipId);
  const songs = project.layout.songs ?? [];
  if (!clip || !placed || songs.length === 0) return null;
  const middle = placed.at + placed.length / 2;
  const n = songs.findIndex(song => middle < song.at + song.length);
  const song = songs[n === -1 ? songs.length - 1 : n];
  const id = project.songIds[song.index];
  return { clip, song, reference: id !== null && id !== undefined ? String(id) : song.src };
}

/** The project in view. */
export function useActiveProject(): LaneProject | null {
  return useLaneEditor(state => state.projects.find(p => p.path === state.active) ?? null);
}
