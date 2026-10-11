import { useEffect, useSyncExternalStore } from "react";
import { Maximize2, Minimize2, Pin, PinOff } from "lucide-react";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { lyricLineAt } from "../../lib/miniPlayerLyric";
import { getPlayerSession, subscribePlayerSession } from "../../lib/playerSession";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useLyricsStore } from "../../stores/lyricsStore";
import { updateTask, useTaskBubbles } from "../tasks/taskBubbleStore";
import {
  MINI_PLAYER_BUBBLE,
  collapseToMiniPlayer,
  expandFromMiniPlayer,
  fitMiniPlayer,
  miniPlayerOffered,
  setMiniPlayerOnTop,
  syncMiniPlayer,
  useMiniPlayer,
} from "../../lib/miniPlayer";
import "./MiniPlayer.css";

/** How often the window is checked against the bubble, and how long a bubble may be missing. */
const FIT_EVERY_MS = 200;
const MISSING_MS = 1600;
/** What a press on the bubble belongs to instead of moving the window. */
const NOT_A_HANDLE = "button, a, input, select, textarea, [role='slider'], .kd-task-controls";

/**
 * The way down, among the window's own keys in the top right of the whole window
 * (ChromeActions): it takes the window down to the playing song's bubble, so it is there only
 * with a song.
 */
export function ChromeMiniPlayerKey() {
  const phase = useMiniPlayer(state => state.phase);
  const song = useSyncExternalStore(subscribePlayingTrack, () => getPlayingTrack()?.id ?? null, () => null);
  if (!miniPlayerOffered()) return null;
  return <button type="button" className="kd-chrome-btn" data-task-action="mini"
    aria-label="收成迷你播放器" title="收成迷你播放器" disabled={phase !== "off" || song === null}
    onClick={() => { void collapseToMiniPlayer(); }}>
    <Minimize2 size={16} aria-hidden="true" />
  </button>;
}

/**
 * The mini player's own keys, in the tool row of the playing song's bubble
 * (docs/task-bubbles.md), shown as the mini player only (MiniPlayer.css): whether it floats
 * over other windows, and the way back.
 */
export function MiniPlayerKeys() {
  const phase = useMiniPlayer(state => state.phase);
  const onTop = useMiniPlayer(state => state.onTop);
  if (!miniPlayerOffered()) return null;
  const floats = onTop ? "置顶：开。点一下不再浮在其他窗口上面" : "置顶：关。点一下浮在其他窗口上面";
  return <>
    <button type="button" className="kd-task-action kd-mini-key" data-task-action="mini-top" data-when="mini"
      aria-label={onTop ? "取消置顶" : "置顶"} title={floats} aria-pressed={onTop} disabled={phase !== "on"}
      onClick={() => { void setMiniPlayerOnTop(!onTop); }}>
      {onTop ? <Pin size={14} aria-hidden="true" /> : <PinOff size={14} aria-hidden="true" />}
    </button>
    <button type="button" className="kd-task-action kd-mini-key" data-task-action="mini-back" data-when="mini"
      aria-label="展开窗口" title="展开窗口" disabled={phase !== "on"} onClick={() => { void expandFromMiniPlayer(); }}>
      <Maximize2 size={14} aria-hidden="true" />
    </button>
  </>;
}

/**
 * The line under the title is the lyric that is being sung, while the song has lyrics and the
 * window is the mini player; otherwise it is the artist, as in the whole window. The bubble's
 * own description is written by NowPlayingTask; this only keeps that one line current, and
 * hands it back when the mini player ends.
 */
function useMiniPlayerLyric(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    let cached: number | null = null;
    const playing = () => useTaskBubbles.getState().entries.find(entry => entry.spec.kind === "playing" && !entry.leaving);
    const write = (line: string, keep = false) => {
      const entry = playing();
      const track = getPlayingTrack();
      if (!entry || !track || entry.spec.song !== track.id) return;
      // A song with lyrics keeps the line between two of them, so the window does not change
      // height every time the singing stops.
      const detail = line || track.artist || (keep ? "\u00a0" : undefined);
      if (entry.spec.detail !== detail) updateTask(entry.spec.id, { detail });
    };
    const update = () => {
      const track = getPlayingTrack();
      if (!track) return;
      if (cached !== track.id) {
        cached = track.id;
        // Lyrics that are already kept for the song; looking them up online stays the lyrics' own.
        void useLyricsStore.getState().ensure(track, { cacheOnly: true });
      }
      const session = getPlayerSession();
      const lines = useLyricsStore.getState().get(track.id).lines;
      write(session.trackId === track.id ? lyricLineAt(lines, session.position) : "", hasVisibleLyrics(lines));
    };
    const stops = [subscribePlayerSession(update), subscribePlayingTrack(update), useLyricsStore.subscribe(update), useTaskBubbles.subscribe(update)];
    update();
    return () => {
      for (const stop of stops) stop();
      write("");
    };
  }, [on]);
}

/**
 * What the mini player needs of the page while it lasts: the bubble is the window's handle,
 * the window keeps the bubble's height, Esc does not roll the only thing on screen away, and
 * a window left without a song to show is given back.
 */
export function MiniPlayerHost() {
  const on = useMiniPlayer(state => state.phase === "on");
  useEffect(() => { void syncMiniPlayer(); }, []);
  useMiniPlayerLyric(on);
  useEffect(() => {
    if (!on) return;
    const drag = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (!event.target.closest(MINI_PLAYER_BUBBLE) || event.target.closest(NOT_A_HANDLE)) return;
      window.kdj?.windowControl("drag");
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
    };
    // The window follows the bubble the moment it changes height (another song's title).
    let watched: Element | null = null;
    const sized = typeof ResizeObserver === "function" ? new ResizeObserver(() => { fitMiniPlayer(); }) : null;
    const watch = () => {
      const bubble = document.querySelector(MINI_PLAYER_BUBBLE);
      if (bubble === watched) return;
      sized?.disconnect();
      watched = bubble;
      if (bubble) sized?.observe(bubble);
    };
    let missingSince = 0;
    const fit = window.setInterval(() => {
      watch();
      if (fitMiniPlayer()) { missingSince = 0; return; }
      missingSince ||= performance.now();
      if (performance.now() - missingSince > MISSING_MS) void expandFromMiniPlayer();
    }, FIT_EVERY_MS);
    document.addEventListener("pointerdown", drag);
    window.addEventListener("keydown", key, true);
    watch();
    return () => {
      sized?.disconnect();
      window.clearInterval(fit);
      document.removeEventListener("pointerdown", drag);
      window.removeEventListener("keydown", key, true);
    };
  }, [on]);
  return null;
}
