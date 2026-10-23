/**
 * The editor of `.kdjv` 3 projects (docs/kdjv.md, "格式 3"; LaneEditor.tsx), a drawer app. Several
 * projects are open at once, one page of the drawer's title each. Each holds its document as the
 * server last saved it: every change is a list of operations sent to `/api/kdjv/edit`, which checks
 * the result as playing it would and only then writes it, so what is shown is always what is on
 * disk. A project plays as a library row like any other; its picture is the video window's
 * (KdjvLivePicture), refreshed after each edit.
 */
import { create } from "zustand";
import { api } from "../lib/api";
import { isImageTrack, isProjectTrack, isVideoTrack } from "../lib/format";
import { refreshPlayingProject } from "../lib/kdjvPlay";
import { alignedOps, allClips, clipLength, findClip, LANE_END, snapToBar, type AlignPlan, type LaneClip, type LaneDocument, type LaneEdited, type LaneLayout, type LaneOp, type NewClip, type TrackKind } from "../lib/lanes";
import { useSidePanels } from "../lib/sidePanels";
import type { Track } from "../types";

export const LANE_EDITOR_APP = "lane-editor";

/** Bar lines and beats in seconds of the project, through every song of the song lane. */
export interface LaneGrid { downbeats: number[]; beats: number[] }

/** One song's own grid, in seconds of the song; `precise` once the full analysis has answered. */
interface SongGrid { downbeats: number[]; beats: number[]; precise: boolean }

/** How many edits back undo reaches. */
const HISTORY = 100;

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
  /** How long each file the document names is, by its name there (from the last check). */
  lengths: Record<string, number>;
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
  /** Clips being found in their song (校准), by `alignKey`. */
  aligning: string[];
  /** What 校准 found for a clip, by `alignKey`: its plans, best first, or none that fit. */
  plans: Record<string, AlignFound>;
  /** Each project's documents before its edits (undo) and after the ones undone (redo), by path. */
  history: Record<string, { past: LaneDocument[]; future: LaneDocument[] }>;
  /** Whether what is dragged lands on the song's beats (N; Alt while dragging lets it go free). */
  snap: boolean;
  /** Each project's in and out points (I and O), in seconds, by path: what 导出 can write out. */
  ranges: Record<string, { in?: number; out?: number }>;
  /** The clip copied (⌘C), with the track it was in: pasted as it was, in any open project. */
  clipboard: { clip: NewClip; track: string; kind: TrackKind } | null;
  /** Copies the chosen clip (⌘C); with `cut`, takes it out too (⌘X). */
  copy(cut?: boolean): void;
  /**
   * The copied clip into the project in view (⌘V): at `at` (the playhead), else after the last
   * clip of its track, in a track of the same id and kind, else the first of its kind. The new
   * clip is chosen. Whatever it lands on in that track gives way, as with a drop.
   */
  paste(at: number | null): Promise<void>;
  /** The chosen clip once more, right after itself in its track (⌘D); the copy is chosen. */
  duplicate(): Promise<void>;
  toggleSnap(): void;
  /** The in (I) or out (O) point of the project in view at `at`; an out before the in, or the reverse, clears the other. */
  setRange(end: "in" | "out", at: number): void;
  /** Opens the drawer as it was (the key at the top right). */
  show(): void;
  openTrack(track: Pick<Track, "id" | "path">): Promise<void>;
  /** Opens the project file at `path` (a page again, if it was closed); false when it cannot be opened. */
  openPath(path: string): Promise<boolean>;
  startVj(song: Track): Promise<void>;
  startVideo(video: Track): Promise<void>;
  /** A new project from what was dropped: the songs one after another (a VJ), else the videos;
   *  with `sound`, videos too give only their sound, as songs. */
  createFrom(tracks: Track[], sound?: boolean): Promise<void>;
  activate(path: string): void;
  /** Takes a project out of the editor (the file stays). */
  closeProject(path: string): void;
  /** Sends the operations to the project in view (or at `path`); false when they were refused (the reason is in `error`). */
  edit(ops: LaneOp[], path?: string): Promise<boolean>;
  /**
   * Library rows dropped on the project at `path` go where they belong: songs into a sound track,
   * pictures into a picture track (`place` names them, else the first of their kind, made when
   * there is none), from `place.at` (in a project with songs a picture at the bar), one after
   * another; at `LANE_END` (let go anywhere but on a track) after the last clip there. A project
   * among them opens as a page of its own. No project (`path` null, or one no longer open): they
   * start a new one. `place.sound`: videos alone let go on a sound track, where a video gives only
   * its sound; with a song among them each goes to its own kind of track all the same.
   */
  placeTracks(path: string | null, tracks: Track[], place: Placement): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  select(id: string | null): void;
  /** Says what could not be done, in the editor's status line. */
  fail(reason: string): void;
  close(): void;
  /** Finds where a clip of the project in view lies in the song under it; `auto` applies a sure plan at once. */
  calibrate(clipId: string, auto?: boolean): Promise<void>;
  applyPlan(clipId: string, plan: AlignPlan): Promise<void>;
}

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const separator = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
const cleanName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_").trim() || "工程";
/**
 * What the server said, in the editor's words: without the step of the list it was ("第 2 步（add）：")
 * and the document's own names of a clip ("main[1]（主线第 2 段，a.mp4）" says 主线第 2 段，a.mp4),
 * which are for the AI that wrote the list.
 */
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/第 \d+ 步（[a-z_]+）：/g, "")
  .replace(/(?:main|songs|titles|branches)\[\d+\]（([^）]*)）/g, "$1");
const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** What 校准 found for one clip's file in its song. */
export interface AlignFound { plans: AlignPlan[]; reason?: string }

/**
 * Whose 校准 a result is: the project, the clip and its file. Clip ids repeat from project to
 * project (c1, c2…), and a clip's file can change, so a result never shows on another clip.
 */
export const alignKey = (path: string, clipId: string, src: string) => `${path}\n${clipId}\n${src}`;

/** A song for the song lane; a picture for the picture lane. Projects themselves are neither. */
export const isSongTrack = (track: Pick<Track, "format">) =>
  !isVideoTrack(track.format) && !isImageTrack(track.format) && !isProjectTrack(track.format);
export const isPictureTrack = (track: Pick<Track, "format">) => isVideoTrack(track.format) || isImageTrack(track.format);

/** The whole file, its length when the library knows it, else measured by the server (no `out`). */
const length = (track: Track) => (track.duration && track.duration > 0 ? { out: track.duration } : {});
export const songOf = (track: Track): NewClip => ({ src: track.path, in: 0, ...length(track) });
export const clipOf = (track: Track, muted: boolean): NewClip => ({ src: track.path, in: 0, ...length(track), muted, fill: true });

/** Where a drop goes (`placeTracks`): from `at` (LANE_END: after the last clip), into these tracks. */
export interface Placement {
  at: number;
  /** Videos alone taken for their sound (let go on a sound track). */
  sound?: boolean;
  /** The picture track pictures go into, and the sound track songs go into. */
  picture?: string;
  song?: string;
}

/** The songs of a document: the clips of its first sound track that has any (where bar lines come from). */
export function songsOf(doc: LaneDocument): LaneClip[] {
  return doc.tracks.find(track => track.kind === "sound" && track.clips.length > 0)?.clips ?? [];
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

/**
 * Edits run one after another: one sent while the last is being saved waits for it — but not for
 * longer than TURN_WAIT_MS, so that one save that never answers cannot hold every later edit
 * (a delete pressed after it did nothing at all).
 */
const TURN_WAIT_MS = 20_000;
let chain: Promise<unknown> = Promise.resolve();
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = Promise.race([run, new Promise(resolve => window.setTimeout(resolve, TURN_WAIT_MS))]).catch(() => undefined);
  return run;
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
    const kept = get().projects.find(p => p.path === edited.path)?.lengths ?? {};
    const project: LaneProject = {
      path: edited.path, trackId: edited.track_id, songIds, doc: edited.document, layout: edited.layout,
      grid: projectGrid(edited.document, edited.layout, songIds),
      analysing: songIds.some(id => id !== null && waiting.has(id)),
      lengths: { ...kept, ...(edited.lengths ?? {}) },
    };
    set(state => {
      const known = state.projects.some(p => p.path === project.path);
      // What was chosen stays chosen while it is still there: a clip, a title or a song.
      const doc = edited.document;
      const still = (id: string) => id.startsWith("title:") ? (doc.titles ?? []).some(t => `title:${t.id}` === id)
        : findClip(doc, id) !== null;
      const selected = state.active === project.path && state.selected && still(state.selected) ? state.selected : null;
      return {
        open: true, busy: false, error: edited.problem ? `这个工程现在放不了：${edited.problem}` : null, active: project.path, selected,
        projects: known ? state.projects.map(p => (p.path === project.path ? project : p)) : [...state.projects, project],
      };
    });
    for (const id of songIds) if (id !== null) void loadSongGrid(id);
    if (edited.track_id !== null) void refreshPlayingProject(edited.track_id, edited.live);
  };


  /** Keeps `before` for undo: an edit clears what was undone; an undo keeps it for redo, and back. */
  const remember = (path: string, before: LaneDocument, how: "edit" | "undo" | "redo") => set(state => {
    const kept = state.history[path] ?? { past: [], future: [] };
    const cap = (list: LaneDocument[]) => list.slice(-HISTORY);
    const next = how === "edit" ? { past: cap([...kept.past, before]), future: [] }
      : how === "undo" ? { past: kept.past, future: cap([...kept.future, before]) }
        : { past: cap([...kept.past, before]), future: kept.future };
    return { history: { ...state.history, [path]: next } };
  });

  /** Puts the last document of `from` back with `restore`; the one it replaces goes to the other side. */
  const turnBack = async (from: "past" | "future") => {
    const { active, busy, history } = get();
    const kept = active ? history[active] : undefined;
    const now = get().projects.find(p => p.path === active)?.doc;
    if (!active || busy || !kept || !now || kept[from].length === 0) return;
    const document = kept[from][kept[from].length - 1];
    set(state => ({ busy: true, error: null, history: { ...state.history, [active]: { ...kept, [from]: kept[from].slice(0, -1) } } }));
    try {
      adopt(await api.editKdjv({ path: active, ops: [{ op: "restore", document }] }));
      remember(active, now, from === "past" ? "undo" : "redo");
    } catch (error) {
      // Not restorable (a source gone): it stays where it was.
      set(state => ({ busy: false, error: message(error), history: { ...state.history, [active]: kept } }));
    }
  };

  /** A new project beside `beside`, named after it; a name already taken gets a number. False when it could not be made. */
  const create = async (beside: string, name: string, ops: LaneOp[]): Promise<boolean> => {
    set({ busy: true, error: null, open: true });
    const folder = folderOf(beside);
    for (let n = 1; n <= 20; n++) {
      const path = `${folder}${separator(beside)}${cleanName(n === 1 ? name : `${name} ${n}`)}.kdjv`;
      try {
        adopt(await api.editKdjv({ path, ops, create: true }));
        return true;
      } catch (error) {
        if (!message(error).includes("已经有这个文件")) {
          set({ busy: false, error: message(error) });
          return false;
        }
      }
    }
    set({ busy: false, error: "这个文件夹里同名的工程太多了" });
    return false;
  };

  /**
   * Files dropped together go in together; when that is refused, one file that cannot go in does
   * not keep the others out: each goes on its own, and the
   * ones refused are named with why. True when any went in.
   */
  const editEach = async (path: string, ops: LaneOp[]): Promise<boolean> => {
    if (await get().edit(ops, path)) return true;
    if (ops.length < 2) return false;
    const refused: string[] = [];
    let any = false;
    for (const op of ops) {
      if (await get().edit([op], path)) { any = true; continue; }
      const src = op.op === "add" ? op.clip.src : "";
      refused.push(`${fileName(src)}：${get().error ?? ""}`);
    }
    set({ error: refused.length ? `没放进去：${refused.join("；")}` : null });
    return any;
  };

  /**
   * One clip added to `project`; the clip it became is chosen: a new one of its file (a clip it
   * lands in the middle of is cut in two, and the far piece is new too), where it was put.
   */
  const putIn = async (project: LaneProject, op: Extract<LaneOp, { op: "add" }>) => {
    const before = new Set(allClips(project.doc).map(({ clip }) => clip.id));
    if (!(await get().edit([op], project.path))) return;
    const now = get().projects.find(p => p.path === project.path);
    const made = (now ? allClips(now.doc) : []).filter(({ clip }) => !before.has(clip.id) && clip.src === op.clip.src)
      .sort((a, b) => (op.at === undefined ? b.clip.at - a.clip.at : Math.abs(a.clip.at - op.at) - Math.abs(b.clip.at - op.at)))[0];
    if (made && get().active === project.path) set({ selected: made.clip.id });
  };

  return {
    open: false, projects: [], active: null, selected: null, busy: false, error: null, aligning: [], plans: {}, history: {},
    snap: true, ranges: {}, clipboard: null,
    toggleSnap: () => set(state => ({ snap: !state.snap })),
    setRange(end, at) {
      const path = get().active;
      if (!path) return;
      set(state => {
        const now = state.ranges[path] ?? {};
        const next = end === "in"
          ? { in: at, out: now.out !== undefined && now.out > at ? now.out : undefined }
          : { out: at, in: now.in !== undefined && now.in < at ? now.in : undefined };
        return { ranges: { ...state.ranges, [path]: next } };
      });
    },
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
    async openPath(path) {
      const known = get().projects.find(p => p.path === path);
      if (known) { set({ open: true, active: known.path, selected: null }); return true; }
      set({ open: true, busy: true, error: null, selected: null });
      try {
        adopt(await api.editKdjv({ path, ops: [] }));
        return true;
      } catch (error) {
        set({ busy: false, error: message(error) });
        return false;
      }
    },
    startVj: song => get().createFrom([song]),
    startVideo: video => get().createFrom([video]),
    async createFrom(tracks, sound = false) {
      const asSound = sound && !tracks.some(isSongTrack);
      const songs = tracks.filter(track => isSongTrack(track) || (asSound && isVideoTrack(track.format)));
      const pictures = tracks.filter(track => !songs.includes(track) && isPictureTrack(track));
      const first = songs[0] ?? pictures[0];
      if (!first) return;
      const title = songs.length ? `${songs[0].title || "未命名"} VJ` : `${pictures[0].title || "未命名"} 剪辑`;
      // Songs one after another in a sound track; pictures one after another in a picture track,
      // without their own sound when there are songs.
      const adds: LaneOp[] = [
        ...songs.map(song => ({ op: "add" as const, clip: songOf(song), kind: "sound" as const })),
        ...pictures.map(picture => ({ op: "add" as const, clip: clipOf(picture, songs.length > 0), kind: "picture" as const })),
      ];
      let made = await create(first.path, title, [{ op: "new", title }, ...adds]);
      if (!made && adds.length > 1) {
        // One of them could not go in: the project is made without them, then each is put in on its own.
        made = await create(first.path, title, [{ op: "new", title }]);
        const path = get().active;
        if (made && path) await editEach(path, adds);
      }
      // Each video put under songs is looked for in them, and moved there when it is found for sure.
      const now = get().projects.find(p => p.path === get().active);
      if (!made || !now || !songs.length || !pictures.length) return;
      for (const track of now.doc.tracks.filter(t => t.kind === "picture")) for (const clip of track.clips) void get().calibrate(clip.id, true);
    },
    activate: path => set({ active: path, selected: null, error: null }),
    closeProject(path) {
      set(state => {
        const at = state.projects.findIndex(p => p.path === path);
        const projects = state.projects.filter(p => p.path !== path);
        const active = state.active !== path ? state.active : (projects[Math.min(at, projects.length - 1)]?.path ?? null);
        const { [path]: _gone, ...history } = state.history;
        return { projects, active, selected: null, error: null, history };
      });
    },
    edit(ops, path) {
      const active = path ?? get().active;
      if (!active || ops.length === 0) return Promise.resolve(false);
      return inTurn(async () => {
        const before = get().projects.find(p => p.path === active)?.doc;
        set({ busy: true, error: null });
        try {
          adopt(await api.editKdjv({ path: active, ops }));
          if (before) remember(active, before, "edit");
          return true;
        } catch (error) {
          set({ busy: false, error: message(error) });
          return false;
        }
      });
    },
    async placeTracks(path, tracks, place) {
      // A project dropped in is opened, as a page of its own, not put inside another.
      for (const project of tracks.filter(track => isProjectTrack(track.format))) await get().openTrack(project);
      const rest = tracks.filter(track => !isProjectTrack(track.format));
      if (rest.length === 0) return;
      // Songs and videos dropped together each go to their own kind of track: only videos alone,
      // let go on a sound track, are taken for their sound.
      const asSound = Boolean(place.sound) && !rest.some(isSongTrack);
      const heard = (track: Track) => isSongTrack(track) || (asSound && isVideoTrack(track.format));
      const project = path ? get().projects.find(p => p.path === path) : undefined;
      if (!project) { await get().createFrom(rest, asSound); return; }
      const { doc, grid } = project;
      const songs = rest.filter(heard), pictures = rest.filter(track => !heard(track) && isPictureTrack(track));
      const vj = songsOf(doc).length > 0 || songs.length > 0;
      const ops: LaneOp[] = [];
      /** One after another from `from` (each where the one before ends, as far as the library knows its length). */
      const run = (items: Track[], kind: "sound" | "picture", track: string | undefined, from: number | undefined, clip: (t: Track) => NewClip) => {
        let at = from;
        for (const item of items) {
          ops.push({ op: "add", clip: clip(item), kind, ...(track ? { track } : {}), ...(at !== undefined ? { at: Math.round(at * 1000) / 1000 } : {}) });
          // A length the library does not know: the next goes after the last clip there.
          at = at !== undefined && item.duration && item.duration > 0 ? at + item.duration : undefined;
        }
      };
      const at = place.at >= LANE_END ? undefined : place.at;
      run(songs, "sound", place.song, at, songOf);
      // In a project with songs a picture goes in at the bar where it is let go, without its own sound.
      run(pictures, "picture", place.picture, at !== undefined && vj ? snapToBar(grid?.downbeats ?? [], at) : at, picture => clipOf(picture, vj));
      if (ops.length === 0) return;
      const before = new Set(doc.tracks.flatMap(track => track.clips.map(clip => clip.id)));
      if (!(await editEach(project.path, ops)) || !pictures.length) return;
      // Each video put under songs is looked for in them, and moved there when it is found for sure.
      const now = get().projects.find(p => p.path === project.path);
      if (!now || songsOf(now.doc).length === 0 || get().active !== project.path) return;
      for (const track of now.doc.tracks.filter(t => t.kind === "picture")) {
        for (const clip of track.clips) if (!before.has(clip.id)) void get().calibrate(clip.id, true);
      }
    },
    copy(cut = false) {
      const project = get().projects.find(p => p.path === get().active);
      const found = project && findClip(project.doc, get().selected);
      if (!found) return;
      const { id, at: _at, ...clip } = found.clip;
      set({ clipboard: { clip, track: found.track.id, kind: found.track.kind } });
      if (cut) void get().edit([{ op: "remove", id }]);
    },
    async paste(at) {
      const { clipboard } = get();
      const project = get().projects.find(p => p.path === get().active);
      if (!clipboard || !project) return;
      const same = project.doc.tracks.find(track => track.id === clipboard.track && track.kind === clipboard.kind);
      await putIn(project, { op: "add", clip: clipboard.clip, ...(same ? { track: same.id } : { kind: clipboard.kind }),
        ...(at !== null ? { at: Math.round(Math.max(0, at) * 1000) / 1000 } : {}) });
    },
    async duplicate() {
      const project = get().projects.find(p => p.path === get().active);
      const found = project && findClip(project.doc, get().selected);
      if (!project || !found) return;
      const { id: _id, at, ...clip } = found.clip;
      await putIn(project, { op: "add", clip, track: found.track.id, at: Math.round((at + clipLength(found.clip)) * 1000) / 1000 });
    },
    undo: () => inTurn(() => turnBack("past")),
    redo: () => inTurn(() => turnBack("future")),
    select: id => set({ selected: id }),
    fail: reason => set({ error: reason }),
    close: () => set({ open: false, selected: null, error: null }),
    async calibrate(clipId, auto = false) {
      const project = get().projects.find(p => p.path === get().active);
      const target = project && songUnder(project, clipId);
      if (!project || !target) return;
      const before = target.clip;
      const key = alignKey(project.path, clipId, before.src);
      if (get().aligning.includes(key)) return;
      set(state => ({ aligning: [...state.aligning, key], error: null }));
      try {
        const reply = await api.align(target.reference, before.src);
        set(state => ({ plans: { ...state.plans, [key]: { plans: reply.plans, reason: reply.reason } } }));
        const now = get().projects.find(p => p.path === project.path);
        const still = now ? findClip(now.doc, clipId)?.clip : undefined;
        // A plan sure enough goes in by itself, unless the clip was changed meanwhile.
        if (auto && reply.plans[0]?.auto && still && still.in === before.in && still.out === before.out && get().active === project.path) {
          await get().applyPlan(clipId, reply.plans[0]);
        }
      } catch (error) {
        if (!auto) set({ error: message(error) });
      } finally {
        set(state => ({ aligning: state.aligning.filter(id => id !== key) }));
      }
    },
    async applyPlan(clipId, plan) {
      const project = get().projects.find(p => p.path === get().active);
      const target = project && songUnder(project, clipId);
      if (!target) return;
      const ops = alignedOps(target.clip, target.track, plan, target.song);
      if (ops.length && await get().edit(ops)) {
        set(state => {
          const { [alignKey(project.path, clipId, target.clip.src)]: _gone, ...plans } = state.plans;
          return { plans, selected: null };
        });
      }
    },
  };
});

/** A clip of the project with the song it starts over, and how to name that song to the aligner. */
function songUnder(project: LaneProject, clipId: string) {
  const found = findClip(project.doc, clipId);
  const songs = project.layout.songs ?? [];
  if (!found || songs.length === 0) return null;
  const { clip, track } = found;
  const middle = clip.at + clipLength(clip) / 2;
  const n = songs.findIndex(song => middle < song.at + song.length);
  const song = songs[n === -1 ? songs.length - 1 : n];
  const id = project.songIds[song.index];
  return { clip, track: track.id, song, reference: id !== null && id !== undefined ? String(id) : song.src };
}

/** The project in view. */
export function useActiveProject(): LaneProject | null {
  return useLaneEditor(state => state.projects.find(p => p.path === state.active) ?? null);
}
