import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { runtimePlayer } from "./unifiedPlayer";
import { getLocalVideoClock } from "./mediaSync";
import { makeCompositionPreviewTrack, updateCompositionPreviewAudio } from "./streamTrack";
import { playTrack, PLAY_EVENT, type PlayRequest } from "./playTrack";
import { useWorkshopStore } from "../stores/workshopStore";
import { projectDuration } from "./workshop";
import type { Track } from "../types";
export interface WorkshopPlayback {
  ticket: string | null;
  playing: boolean;
  loading: boolean;
  error: string;
  trackId: number | null;
  toggle(): void;
  seek(ms: number): void;
  beginScrub(): void;
  endScrub(): void;
  stop(): void;
  time(): number;
}
export function useWorkshopPlayback(): WorkshopPlayback {
  const projectId = useWorkshopStore((s) => s.activeId),
    revision = useWorkshopStore((s) => s.draft?.revision),
    auditionAfterLayer = useWorkshopStore((s) => s.activeId ? s.auditionAfterLayer[s.activeId] : undefined),
    saving = useWorkshopStore((s) => s.saving),
    gesture = useWorkshopStore((s) => s.gesture !== null);
  const [ticket, setTicket] = useState<string | null>(null),
    [playing, setPlaying] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const track = useRef<Track | null>(null),
    ticketRef = useRef<string | null>(null),
    audioTickets = useRef(new Map<string, string>()),
    activeAudition = useRef<string | null>(null),
    auditionFlight = useRef(false),
    epoch = useRef(0),
    wantPlay = useRef(false),
    dispatching = useRef(false),
    projectRef = useRef(projectId),
    seekTarget = useRef<{ ms: number; at: number } | null>(null),
    seekPending = useRef<number | null>(null),
    seeking = useRef(false),
    scrubResume = useRef(false),
    scrubEpoch = useRef(0),
    scrubPause = useRef<Promise<void>>(Promise.resolve()),
    seekFlight = useRef<Promise<void> | null>(null);
  const time = useCallback(() => {
    const state = runtimePlayer().state();
    const current = useWorkshopStore.getState();
    if (current.scrubbing) return current.position;
    if (seekTarget.current) {
      if (Math.abs(state.currentTime * 1000 - seekTarget.current.ms) < 120)
        seekTarget.current = null;
      else if (performance.now() - seekTarget.current.at < 3000)
        return seekTarget.current.ms;
      else seekTarget.current = null;
    }
    if (
      track.current &&
      state.trackId === track.current.id &&
      !state.buffering
    ) {
      const clock = state.playing ? getLocalVideoClock(track.current.id) : null;
      return (clock?.position ?? state.currentTime) * 1000;
    }
    return useWorkshopStore.getState().position;
  }, []);
  const pause = useCallback(() => {
    setPlaying(false);
    if (track.current && runtimePlayer().state().trackId === track.current.id)
      return runtimePlayer()
        .pause()
        .then(() => {})
        .catch((e) => setError(String(e)));
    return Promise.resolve();
  }, []);
  const stop = useCallback(() => {
    wantPlay.current = false;
    scrubResume.current = false;
    epoch.current++;
    pause();
  }, [pause]);
  const prepare = useCallback(async () => {
    const current = useWorkshopStore.getState();
    if (
      !current.draft ||
      current.saving ||
      current.gesture ||
      projectDuration(current.draft) <= 0
    )
      return;
    const p = current.draft,
      audition = current.auditionAfterLayer[p.id] ?? "",
      request = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.previewWorkshop(p.id, p.revision, audition || undefined);
      if (epoch.current !== request) {
        void api.releaseWorkshop(result.ticket).catch(() => {});
        return;
      }
      for (const lease of new Set(audioTickets.current.values())) {
        if (lease !== result.ticket) void api.releaseWorkshop(lease).catch(() => {});
      }
      audioTickets.current.clear();
      ticketRef.current = result.ticket;
      audioTickets.current.set(audition, result.ticket);
      activeAudition.current = audition;
      setTicket(result.ticket);
      if (wantPlay.current) {
        const source = p.sources.find((s) =>
          p.layers.some((l) => l.source_id === s.id),
        );
        if (!source) return;
        const template = await api.track(source.track_id);
        if (epoch.current !== request) return;
        const previewTrack = makeCompositionPreviewTrack(
          template,
          p.name,
          api.workshopAudioUrl(result.ticket),
          projectDuration(p) / 1000,
        );
        track.current = previewTrack;
        dispatching.current = true;
        playTrack(
          previewTrack,
          true,
          "composition",
          useWorkshopStore.getState().position / 1000,
        );
        dispatching.current = false;
      }
    } catch (e) {
      if (epoch.current === request) {
        setError((e as Error).message);
        wantPlay.current = false;
      }
    } finally {
      if (epoch.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const changedProject = projectRef.current !== projectId;
    projectRef.current = projectId;
    if (changedProject) wantPlay.current = false;
    else if (
      track.current &&
      runtimePlayer().state().trackId === track.current.id &&
      runtimePlayer().state().playing
    )
      wantPlay.current = true;
    if (!changedProject && track.current && runtimePlayer().state().trackId === track.current.id)
      useWorkshopStore.getState().seek(time());
    epoch.current++;
    pause();
    track.current = null;
    scrubResume.current = false;
    seekPending.current = null;
    seekTarget.current = null;
    for (const lease of new Set(audioTickets.current.values()))
      void api.releaseWorkshop(lease).catch(() => {});
    audioTickets.current.clear();
    activeAudition.current = null;
    ticketRef.current = null;
    setTicket(null);
    if (!saving && !gesture) {
      const timer = setTimeout(() => void prepare(), 120);
      return () => clearTimeout(timer);
    }
  }, [projectId, revision, saving, gesture, pause, prepare, time]);
  useEffect(() => {
    const player = runtimePlayer();
    if (auditionFlight.current || !ticketRef.current
      || (track.current && (player.state().trackId !== track.current.id || !player.replaceAudio))) return;
    const wanted = auditionAfterLayer ?? "";
    if (activeAudition.current === wanted) return;
    const request = ticketRef.current, currentTrack = track.current;
    auditionFlight.current = true;
    // Serialize rapid A/B switches. The original mix and video continue while
    // the new mix renders; only the latest requested audition reaches the Deck.
    void (async () => {
      while (request === ticketRef.current && track.current === currentTrack) {
        const editor = useWorkshopStore.getState(), p = editor.draft;
        if (!p || p.id !== projectRef.current || (currentTrack && player.state().trackId !== currentTrack.id)) return;
        const next = editor.auditionAfterLayer[p.id] ?? "";
        if (activeAudition.current === next) return;
        let lease = audioTickets.current.get(next);
        if (!lease) {
          const result = await api.previewWorkshop(p.id, p.revision, next || undefined);
          if (request !== ticketRef.current || track.current !== currentTrack) {
            void api.releaseWorkshop(result.ticket).catch(() => {});
            return;
          }
          lease = result.ticket;
          audioTickets.current.set(next, lease);
        }
        if ((useWorkshopStore.getState().auditionAfterLayer[p.id] ?? "") !== next) continue;
        const url = api.workshopAudioUrl(lease);
        if (currentTrack) {
          await player.replaceAudio!({ src: url, track: currentTrack });
          if (request !== ticketRef.current || track.current !== currentTrack) return;
          updateCompositionPreviewAudio(currentTrack, url);
        }
        activeAudition.current = next;
      }
    })().catch(e => {
      if (request === ticketRef.current) setError((e as Error).message);
    }).finally(() => { auditionFlight.current = false; });
  }, [auditionAfterLayer, ticket, playing, loading]);
  useEffect(() => {
    const player = runtimePlayer();
    const update = () => {
      const state = player.state(), active = track.current && state.trackId === track.current.id;
      const editor = useWorkshopStore.getState();
      if (!active) return;
      setPlaying(state.playing && !state.buffering && !editor.scrubbing && !editor.gesture);
      setLoading(state.buffering || state.status === "loading");
      if (state.error) setError(state.error);
      if (state.status === "ended") wantPlay.current = false;
      if (!state.buffering && !editor.scrubbing && !editor.gesture) {
        const next = time();
        if (Math.abs(next - editor.position) >= 1) editor.seek(next);
      }
    };
    // Native state events already pace the UI clock. A second RAF used to
    // wake the entire timeline even while paused or searching in the library.
    const unsubscribe = player.subscribe(update);
    const otherPlay = (event: Event) => {
      if (dispatching.current) return;
      const req = (event as CustomEvent<PlayRequest>).detail;
      if (req?.track?.id === track.current?.id) return;
      wantPlay.current = false;
      epoch.current++;
      track.current = null;
      setPlaying(false);
      setLoading(false);
    };
    window.addEventListener(PLAY_EVENT, otherPlay);
    return () => {
      unsubscribe();
      window.removeEventListener(PLAY_EVENT, otherPlay);
      epoch.current++;
      pause();
      for (const lease of new Set(audioTickets.current.values()))
        void api.releaseWorkshop(lease).catch(() => {});
      audioTickets.current.clear();
    };
  }, [pause, time]);
  const toggle = () => {
    const state = runtimePlayer().state();
    if (wantPlay.current || playing) {
      stop();
      setLoading(false);
      return;
    }
    wantPlay.current = true;
    if (
      track.current &&
      state.trackId === track.current.id &&
      ticketRef.current
    ) {
      if (state.status === "ended") void runtimePlayer().seek(0);
      void runtimePlayer()
        .play()
        .catch((e) => setError(String(e)));
    } else void prepare();
  };
  const seek = (ms: number) => {
    useWorkshopStore.getState().seek(ms);
    const target = useWorkshopStore.getState().position;
    seekTarget.current = { ms: target, at: performance.now() };
    if (useWorkshopStore.getState().scrubbing || !track.current || runtimePlayer().state().trackId !== track.current.id)
      return;
    seekPending.current = target;
    if (seeking.current) return seekFlight.current ?? undefined;
    seeking.current = true;
    const id = track.current.id;
    seekFlight.current = (async () => {
      try {
        while (seekPending.current !== null && track.current?.id === id) {
          const next = seekPending.current;
          seekPending.current = null;
          await runtimePlayer().seek(next / 1000);
          if (useWorkshopStore.getState().scrubbing) { seekPending.current = null; break; }
        }
      } catch (e) {
        setError(String(e));
      } finally {
        seeking.current = false;
        seekFlight.current = null;
      }
    })();
    return seekFlight.current;
  };
  const beginScrub = () => {
    scrubEpoch.current++;
    const state = runtimePlayer().state();
    scrubResume.current = Boolean(track.current && state.trackId === track.current.id && state.playing);
    if (scrubResume.current) wantPlay.current = true;
    scrubPause.current = pause();
  };
  const endScrub = () => {
    const resume = scrubResume.current, id = track.current?.id, request = epoch.current, scrubRequest = scrubEpoch.current;
    scrubResume.current = false;
    void (async () => {
      await scrubPause.current;
      if (request !== epoch.current || scrubRequest !== scrubEpoch.current) return;
      await seek(useWorkshopStore.getState().position);
      if (resume && scrubRequest === scrubEpoch.current && wantPlay.current && request === epoch.current && id != null && track.current?.id === id
        && runtimePlayer().state().trackId === id && !useWorkshopStore.getState().scrubbing)
        await runtimePlayer().play();
    })().catch(e => setError(String(e)));
  };
  return {
    ticket,
    playing,
    loading,
    error,
    trackId: track.current?.id ?? null,
    toggle,
    seek,
    beginScrub,
    endScrub,
    stop,
    time,
  };
}
