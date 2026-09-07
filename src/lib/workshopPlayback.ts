import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { runtimePlayer } from "./unifiedPlayer";
import { captureLocalVideoSeekFence, getLocalVideoClock, waitForLocalVideoSeekLanding } from "./mediaSync";
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
  pendingSeek?(): boolean;
}
export function useWorkshopPlayback(): WorkshopPlayback {
  const projectId = useWorkshopStore((s) => s.activeId),
    revision = useWorkshopStore((s) => s.draft?.revision),
    auditionAfterLayer = useWorkshopStore((s) => s.activeId ? s.auditionAfterLayer[s.activeId] : undefined),
    saving = useWorkshopStore((s) => s.saving),
    gesture = useWorkshopStore((s) => s.gesture !== null);
  // Editorial markers do not invalidate the playing media or its preview lease.
  const mediaKey = useWorkshopStore(s => s.draft
    ? JSON.stringify([s.draft.id, s.draft.name, s.draft.sources, s.draft.layers, s.draft.canvas, s.draft.output]) : "");
  const preparedMediaKey = useRef<string | null>(null);
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
    seekTarget = useRef<{ ms: number } | null>(null),
    seekPending = useRef<number | null>(null),
    seeking = useRef(false),
    scrubResume = useRef(false),
    scrubEpoch = useRef(0),
    scrubPause = useRef<Promise<void>>(Promise.resolve()),
    seekFlight = useRef<Promise<void> | null>(null),
    updatePlayback = useRef<() => void>(() => {});
  const time = useCallback(() => {
    const state = runtimePlayer().state();
    const current = useWorkshopStore.getState();
    if (current.scrubbing) return current.position;
    // Command snapshots may already contain the requested cursor while the DAC
    // still reports the old position. Only the seek transaction releases this pin.
    if (seekTarget.current) return seekTarget.current.ms;
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
    seekPending.current = null;
    seekTarget.current = null;
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
    if (preparedMediaKey.current === mediaKey && ticketRef.current) return;
    preparedMediaKey.current = mediaKey;
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
  }, [projectId, revision, saving, gesture, mediaKey, pause, prepare, time]);
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
      setPlaying(state.playing && !state.buffering && !editor.scrubbing && !editor.gesture && !seekTarget.current);
      setLoading(state.buffering || state.status === "loading");
      if (state.error) {
        setError(state.error);
        wantPlay.current = false;
      } else if (state.playing && !state.buffering) setError("");
      if (state.status === "ended") wantPlay.current = false;
      if (!state.buffering && !editor.scrubbing && !editor.gesture) {
        const next = time();
        if (Math.abs(next - editor.position) >= 1) editor.seek(next);
      }
    };
    // Native state events already pace the UI clock. A second RAF used to
    // wake the entire timeline even while paused or searching in the library.
    updatePlayback.current = update;
    const unsubscribe = player.subscribe(update);
    const otherPlay = (event: Event) => {
      if (dispatching.current) return;
      const req = (event as CustomEvent<PlayRequest>).detail;
      if (req?.track?.id === track.current?.id) return;
      wantPlay.current = false;
      epoch.current++;
      track.current = null;
      seekPending.current = null;
      seekTarget.current = null;
      setPlaying(false);
      setLoading(false);
    };
    window.addEventListener(PLAY_EVENT, otherPlay);
    return () => {
      unsubscribe();
      updatePlayback.current = () => {};
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
    setError("");
    if (
      track.current &&
      state.trackId === track.current.id &&
      ticketRef.current && !state.error && state.status !== "error"
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
    if (!track.current || runtimePlayer().state().trackId !== track.current.id) {
      seekTarget.current = null;
      return;
    }
    seekTarget.current = { ms: target };
    setPlaying(false);
    if (useWorkshopStore.getState().scrubbing) return;
    seekPending.current = target;
    if (seeking.current) return seekFlight.current ?? undefined;
    seeking.current = true;
    const id = track.current.id, request = epoch.current;
    seekFlight.current = (async () => {
      try {
        while (seekPending.current !== null && track.current?.id === id && request === epoch.current) {
          const next = seekPending.current, intent = seekTarget.current;
          const scrubRequest = scrubEpoch.current, player = runtimePlayer();
          const isCurrent = () => request === epoch.current && track.current?.id === id
            && player.state().trackId === id && scrubRequest === scrubEpoch.current;
          seekPending.current = null;
          // Fence each dispatch, not the gesture: queued B must not accept A's clock.
          const fence = player.kind === "desktop-native" ? captureLocalVideoSeekFence(id) : null;
          await player.seek(next / 1000);
          if (fence && isCurrent()) {
            const landed = await waitForLocalVideoSeekLanding(fence, isCurrent);
            if (!landed && isCurrent()) throw new Error("播放跳转未收到音频时钟确认");
          }
          if (isCurrent() && seekTarget.current === intent) seekTarget.current = null;
          if (useWorkshopStore.getState().scrubbing) { seekPending.current = null; break; }
        }
      } catch (e) {
        if (request === epoch.current && track.current?.id === id) {
          seekPending.current = null;
          seekTarget.current = null;
          wantPlay.current = false;
          scrubResume.current = false;
          await pause();
          setError(String(e));
        }
      } finally {
        seeking.current = false;
        seekFlight.current = null;
        updatePlayback.current();
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
    const target = useWorkshopStore.getState().position;
    scrubResume.current = false;
    void (async () => {
      await scrubPause.current;
      if (request !== epoch.current || scrubRequest !== scrubEpoch.current) return;
      await seek(target);
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
    pendingSeek: () => seekTarget.current !== null,
  };
}
