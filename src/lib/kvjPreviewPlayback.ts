import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { projectDuration } from "./workshop";
import { acquireWorkshopVideoPlayback } from "./workshopPreviewPolicy";
import { useWorkshopStore } from "../stores/workshopStore";
import type { WorkshopPlayback } from "./workshopPlayback";
import type { LocalVideoClock } from "./mediaSync";
import { pauseMainForKvjPreview } from "./kvjWindow";
import { captureDiagnostic, mediaDiagnostic, observeMediaDiagnostics } from "./diagnostics";

/** KVJ owns system-decoded preview audio; the main window pauses DJ playback first. */
export function useKvjPreviewPlayback(): WorkshopPlayback {
  const draft = useWorkshopStore(s => s.draft);
  const saving = useWorkshopStore(s => s.saving);
  const gesture = useWorkshopStore(s => s.gesture !== null);
  const audition = useWorkshopStore(s => s.activeId ? s.auditionAfterLayer[s.activeId] : undefined);
  const key = useMemo(() => draft ? JSON.stringify([draft.id, draft.sources, draft.layers, draft.canvas, draft.output]) : "", [draft]);
  const [ticket, setTicket] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [muted, setMuted] = useState(false);
  const [retry, setRetry] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const wantsPlay = useRef(false), resumeScrub = useRef(false);
  const mainPaused = useRef(false), playEpoch = useRef(0);
  const sourceRevision = useRef(0), discontinuity = useRef(0);
  const seekTarget = useRef<number | null>(null);
  const playFlight = useRef<{ node: HTMLAudioElement; epoch: number } | null>(null);
  const play = useCallback(() => {
    const node = audio.current;
    const store = useWorkshopStore.getState();
    if (!node || !wantsPlay.current || !mainPaused.current || store.scrubbing || store.gesture
      || seekTarget.current !== null || node.seeking || node.readyState < 2 || playFlight.current?.node === node) return;
    const flight = { node, epoch: playEpoch.current };
    playFlight.current = flight;
    void node.play().then(() => {
      if (playFlight.current !== flight) return;
      if (audio.current !== node || !wantsPlay.current || flight.epoch !== playEpoch.current) { node.pause(); return; }
      setPlaying(!node.paused && !node.ended);
      setLoading(false);
    }).catch(e => {
      // A scrub, Stop or lease replacement cancels play() deliberately. Its
      // delayed rejection must not cancel the newer resume/play intent.
      if (playFlight.current === flight && audio.current === node && wantsPlay.current && flight.epoch === playEpoch.current) {
        wantsPlay.current = false;
        setPlaying(false);
        setLoading(false);
        setError(String(e));
        captureDiagnostic("playback", "workshop.audio.play", e, mediaDiagnostic(node));
      }
    }).finally(() => { if (playFlight.current === flight) playFlight.current = null; });
  }, []);
  const seek = useCallback((ms: number) => {
    const store = useWorkshopStore.getState();
    store.seek(ms);
    discontinuity.current++;
    const position = useWorkshopStore.getState().position;
    seekTarget.current = position;
    playFlight.current = null;
    setPlaying(false);
    const node = audio.current;
    // The picture follows the drag cursor; the audible transport seeks once on
    // release, rather than flushing a pending play/seek for every pointer move.
    if (!node || node.readyState < 1 || store.scrubbing || store.gesture) return;
    const target = Math.min(position / 1000, Number.isFinite(node.duration) ? node.duration : Infinity);
    if (!node.seeking && Math.abs(node.currentTime - target) < .001) { seekTarget.current = null; play(); }
    else node.currentTime = target;
  }, [play]);
  const stop = useCallback(() => {
    wantsPlay.current = false;
    resumeScrub.current = false;
    mainPaused.current = false;
    playEpoch.current++;
    playFlight.current = null;
    seekTarget.current = null;
    audio.current?.pause();
    setPlaying(false);
    setLoading(false);
  }, []);
  useEffect(() => { stop(); }, [draft?.id, stop]);
  useEffect(() => { if (audio.current) audio.current.muted = muted; }, [muted]);
  // Saving/gestures invalidate the old lease, but preparation never writes the project.
  useEffect(() => {
    setTicket(null);
    setPlaying(false);
    setLoading(false);
    if (!draft || saving || gesture || projectDuration(draft) <= 0) return;
    let disposed = false, lease: string | null = null, node: HTMLAudioElement | null = null;
    let frame = 0, lastTick = 0;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void api.previewWorkshop(draft.id, draft.revision, audition || undefined).then(result => {
        lease = result.ticket;
        if (disposed) { void api.releaseWorkshop(lease).catch(() => {}); return; }
        sourceRevision.current++;
        setTicket(lease);
        node = new Audio();
        observeMediaDiagnostics(node);
        audio.current = node;
        seekTarget.current = useWorkshopStore.getState().position;
        node.preload = "auto";
        node.muted = mutedRef.current;
        const current = node;
        const update = () => {
          if (disposed || audio.current !== current) return;
          const store = useWorkshopStore.getState();
          if (!store.scrubbing && !store.gesture && seekTarget.current === null && !current.seeking)
            store.seek(current.currentTime * 1000);
        };
        const tick = (now: number) => {
          if (disposed || current.paused) return;
          if (now - lastTick >= 1000 / 30) { update(); lastTick = now; }
          frame = requestAnimationFrame(tick);
        };
        const land = () => {
          const store = useWorkshopStore.getState();
          if (store.scrubbing || store.gesture || current.seeking) return;
          const target = seekTarget.current;
          const end = Number.isFinite(current.duration) ? current.duration : Infinity;
          if (target !== null && Math.abs(current.currentTime - Math.min(target / 1000, end)) < .025)
            seekTarget.current = null;
          update();
          play();
        };
        current.onloadedmetadata = () => {
          const store = useWorkshopStore.getState();
          seekTarget.current = store.position;
          if (!store.scrubbing && !store.gesture) {
            const target = Math.min(store.position / 1000, Number.isFinite(current.duration) ? current.duration : Infinity);
            if (Math.abs(current.currentTime - target) >= .001) current.currentTime = target;
            else land();
          }
        };
        current.oncanplay = () => { setLoading(wantsPlay.current && !mainPaused.current); land(); };
        current.onplaying = () => {
          if (!wantsPlay.current || !mainPaused.current || useWorkshopStore.getState().scrubbing || useWorkshopStore.getState().gesture) {
            current.pause(); return;
          }
          setPlaying(true); setLoading(false);
          cancelAnimationFrame(frame); frame = requestAnimationFrame(tick);
        };
        current.onpause = () => { setPlaying(false); cancelAnimationFrame(frame); update(); };
        current.onwaiting = () => { setPlaying(false); setLoading(wantsPlay.current); cancelAnimationFrame(frame); };
        current.onseeked = land;
        current.onended = () => { wantsPlay.current = false; setPlaying(false); setLoading(false); update(); };
        current.onerror = () => {
          wantsPlay.current = false; setPlaying(false); setLoading(false);
          setError(current.error?.message || "无法加载剪辑预览音频");
        };
        current.src = api.workshopAudioUrl(lease);
      }).catch(e => {
        if (!disposed) { setLoading(false); setError(String(e)); wantsPlay.current = false; }
      });
    }, 120);
    return () => {
      disposed = true;
      clearTimeout(timer); cancelAnimationFrame(frame);
      if (node) {
        if (audio.current === node) audio.current = null;
        if (playFlight.current?.node === node) playFlight.current = null;
        node.onpause = node.onplaying = node.onwaiting = node.onended = node.onerror = node.onseeked = node.oncanplay = node.onloadedmetadata = null;
        node.pause(); node.removeAttribute("src"); node.load();
      }
      if (lease) void api.releaseWorkshop(lease).catch(() => {});
    };
    // Muting and marker-only revisions do not regenerate the preview media.
  }, [key, saving, gesture, audition, retry, play]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { document.removeEventListener("visibilitychange", hidden); stop(); };
  }, [stop]);
  const time = () => {
    const store = useWorkshopStore.getState(), node = audio.current;
    if (store.scrubbing || store.gesture) return store.position;
    if (seekTarget.current !== null) return seekTarget.current;
    return node && node.readyState >= 2 && !node.seeking ? node.currentTime * 1000 : store.position;
  };
  return {
    ticket, playing, loading, error, trackId: null, muted,
    toggleMuted: () => setMuted(value => !value),
    toggle: () => {
      if (wantsPlay.current) { stop(); return; }
      if (!useWorkshopStore.getState().draft) return;
      wantsPlay.current = true; mainPaused.current = false;
      // Acquire WebKit playback permission in this actual click/key gesture,
      // before the main-window pause reply or the next animation frame.
      acquireWorkshopVideoPlayback();
      const request = ++playEpoch.current;
      setError(""); setLoading(true);
      if (audio.current?.ended) seek(0);
      if (!audio.current) setRetry(value => value + 1);
      void pauseMainForKvjPreview().then(() => {
        if (request !== playEpoch.current || !wantsPlay.current) return;
        mainPaused.current = true;
        if (!useWorkshopStore.getState().scrubbing) play();
      }).catch(e => {
        if (request !== playEpoch.current || !wantsPlay.current) return;
        stop();
        setError(`无法暂停 KDJ 主音频：${String(e)}`);
      });
    },
    seek, stop, time,
    beginScrub: () => {
      resumeScrub.current = wantsPlay.current;
      playFlight.current = null;
      audio.current?.pause();
      setPlaying(false);
    },
    endScrub: () => {
      seek(useWorkshopStore.getState().position);
      if (resumeScrub.current && wantsPlay.current) play();
      resumeScrub.current = false;
    },
    retry: () => setRetry(value => value + 1),
    pendingSeek: () => seekTarget.current !== null || (audio.current?.seeking ?? false),
    clock: (): LocalVideoClock | null => {
      const node = audio.current;
      if (!node || node.readyState < 3 || node.seeking || seekTarget.current !== null) return null;
      return { trackId: -1, sourceId: sourceRevision.current, discontinuityRevision: discontinuity.current,
        loopGeneration: 0, loopWrapCount: 0, position: node.currentTime, rate: node.playbackRate,
        playing: !node.paused && !node.ended, fresh: true };
    },
  };
}
