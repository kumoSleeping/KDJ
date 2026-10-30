/**
 * One video source decoded by the WebView's own decoder (WebCodecs `VideoDecoder`: VideoToolbox
 * on macOS, Media Foundation on Windows, MediaCodec on Android), read by range from KDJ's server
 * and demuxed by mediabunny. The frames are handed to the caller to draw on its canvas, so the
 * picture is part of the page: no native view, no hole, nothing to fall out of step when the
 * page moves.
 *
 * Three ways to ask for a frame, by what the clip is doing:
 * - `prime(t)`: before its cut. Decoding starts at `t` and stops a few frames ahead, holding
 *   them, so the cut comes in moving with no wait.
 * - `play(t)`: running. Frames come in order from the running decode; the one due at `t` is
 *   shown. A jump outside what is decoded starts the decode again there.
 * - `still(t)`: paused. The exact frame of `t`, decoded from its key frame; one request at a
 *   time, a later target replacing a waiting one (as videoSeekQueue.ts).
 *
 * Every frame is closed as soon as it is replaced: the system decoder's frame pool is small.
 */
import { Input, MATROSKA, MP4, QTFF, UrlSource, VideoSampleSink, WEBM, type VideoSample } from "mediabunny";
import { tracePlayback } from "./playbackTrace";

/** Frames decoded ahead of the one shown, per clip. */
const AHEAD = 4;
/** A target this far past the decoded frames is a jump: the decode starts again there. */
const JUMP_AHEAD_SEC = 0.6;
/** A target this far before the shown frame is a jump back. */
const JUMP_BACK_SEC = 0.05;
/**
 * A decode started less than this long ago is not started again for a target near its own: the
 * clock moving on while its first frames come is not a jump. Restarting on every frame of that
 * wait was what stuttered.
 */
const RESTART_GAP_MS = 150;
const RESTART_NEAR_SEC = 1;
/** Lateness worth reporting, and how often at most. */
const LATE_SEC = 0.1;
const LATE_REPORT_MS = 1_000;

interface Run {
  token: number;
  from: number;
  iterator: AsyncGenerator<VideoSample, void, unknown> | null;
  started: number;
  /** Whether this run was started by a jump while playing (its first frame is a seek's). */
  jump: boolean;
  /** The decode reached the end of the file. */
  ended: boolean;
  /** Where the latest frame of this decode ends, or null before its first. */
  last: number | null;
}

function endOf(sample: VideoSample): number {
  return sample.timestamp + Math.max(sample.duration, 1e-3);
}

export class CodecClip {
  readonly label: string;
  /** The frame to draw now, or null before the first one. */
  current: VideoSample | null = null;
  failed: Error | null = null;
  private readonly input: Input;
  private readonly sink: Promise<VideoSampleSink>;
  private readonly opened = performance.now();
  private queue: VideoSample[] = [];
  private run: Run | null = null;
  private tokens = 0;
  private wake: (() => void) | null = null;
  private stillBusy = false;
  private stillNext: number | null = null;
  private stillAt: number | null = null;
  private lateAt = 0;
  private disposed = false;
  private why = "";
  /** The decode the shown frame came from. */
  private currentRun = 0;
  private whyFrom: number | null = null;

  constructor(url: string, label: string, onError: (error: Error) => void) {
    this.label = label;
    const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new UrlSource(url) });
    this.input = input;
    this.sink = (async () => {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("素材里没有视频");
      if (!(await track.canDecode())) throw new Error(`系统解码器不支持 ${track.codec ?? "这种编码"}`);
      tracePlayback("codec-open", { clip: label, codec: track.codec ?? null, ms: Math.round(performance.now() - this.opened) });
      return new VideoSampleSink(track);
    })();
    this.sink.catch((reason: unknown) => {
      if (this.disposed) return;
      this.failed = reason instanceof Error ? reason : new Error(String(reason));
      tracePlayback("codec-error", { clip: label, error: this.failed.message });
      onError(this.failed);
    });
  }

  /** Before the cut: decode from `t` and hold the first frames. */
  prime(t: number): VideoSample | null {
    if (!this.run || Math.abs(this.run.from - t) > JUMP_BACK_SEC) this.restart(t, false);
    if (!this.current && this.queue.length) {
      this.show(this.queue.shift()!);
      this.currentRun = this.run?.token ?? 0;
    }
    return this.current;
  }

  /** Running: the frame due at `t` from the running decode. */
  play(t: number): VideoSample | null {
    const run = this.run;
    const now = performance.now();
    let why = "";
    if (!run) why = "none";
    else {
      // Only this decode's frames say where it is: the frame still shown may be from before a jump.
      const shown = this.currentRun === run.token ? this.current : null;
      const back = t < (shown ? shown.timestamp : run.from) - JUMP_BACK_SEC;
      // Before its first frame the decode is taken to be keeping up with the clock.
      const lead = run.last ?? run.from + (now - run.started) / 1000;
      // Past the last frame of the file is not a jump: the last frame stays.
      const ahead = !run.ended && t > lead + JUMP_AHEAD_SEC;
      const settling = now - run.started < RESTART_GAP_MS && Math.abs(t - run.from) < RESTART_NEAR_SEC;
      if ((back || ahead) && !settling) why = back ? "back" : "ahead";
    }
    if (why) {
      this.why = why;
      this.whyFrom = run?.last ?? null;
      this.restart(t, Boolean(this.current));
    }
    while (this.queue.length && this.queue[0].timestamp <= t) {
      this.show(this.queue.shift()!);
      this.currentRun = this.run?.token ?? 0;
    }
    if (this.queue.length < AHEAD) this.wakeRun();
    const late = this.current ? t - endOf(this.current) : 0;
    // A jump is not lateness: the frame shown is the old one until the new decode brings its own.
    if (!why && this.currentRun === this.run?.token && late > LATE_SEC && performance.now() - this.lateAt > LATE_REPORT_MS) {
      this.lateAt = performance.now();
      tracePlayback("codec-late", { clip: this.label, ms: Math.round(late * 1000) });
    }
    return this.current;
  }

  /** Paused: the exact frame of `t`. */
  still(t: number): VideoSample | null {
    const covers = (s: VideoSample | null) => s !== null && s.timestamp <= t + 1e-4 && t < endOf(s);
    if (covers(this.current)) return this.current;
    const waiting = this.queue.findIndex(s => covers(s));
    if (waiting >= 0) {
      for (const s of this.queue.splice(0, waiting)) s.close();
      this.show(this.queue.shift()!);
      this.currentRun = this.run?.token ?? 0;
      return this.current;
    }
    if (this.stillAt !== t) {
      this.stillAt = t;
      this.stillNext = t;
      void this.pumpStill();
    }
    return this.current;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRun();
    this.current?.close();
    this.current = null;
    this.input.dispose();
  }

  private show(sample: VideoSample): void {
    if (this.current !== sample) this.current?.close();
    this.current = sample;
  }

  private stopRun(): void {
    const run = this.run;
    this.run = null;
    for (const s of this.queue) s.close();
    this.queue = [];
    this.wakeRun();
    if (run?.iterator) void run.iterator.return(undefined).catch(() => undefined);
  }

  private wakeRun(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private restart(t: number, jump: boolean): void {
    this.stopRun();
    this.stillNext = null;
    this.stillAt = null;
    const run: Run = { token: ++this.tokens, from: t, iterator: null, started: performance.now(), jump, ended: false, last: null };
    this.run = run;
    void this.drive(run);
  }

  private async drive(run: Run): Promise<void> {
    const live = () => !this.disposed && this.run?.token === run.token;
    try {
      const sink = await this.sink;
      if (!live()) return;
      const iterator = sink.samples(Math.max(0, run.from));
      run.iterator = iterator;
      let first = true;
      while (live()) {
        while (live() && this.queue.length >= AHEAD) await new Promise<void>(resolve => { this.wake = resolve; });
        if (!live()) break;
        const next = await iterator.next();
        if (next.done) {
          run.ended = true;
          break;
        }
        if (!live()) {
          next.value.close();
          break;
        }
        this.queue.push(next.value);
        run.last = endOf(next.value);
        if (first) {
          first = false;
          tracePlayback(run.jump ? "codec-seek" : "codec-first", {
            clip: this.label, at: Number(run.from.toFixed(3)), waitMs: Math.round(performance.now() - run.started),
            why: this.why, decoded: this.whyFrom,
          });
        }
      }
    } catch (reason) {
      if (live()) tracePlayback("codec-error", { clip: this.label, error: reason instanceof Error ? reason.message : String(reason) });
    }
  }

  private async pumpStill(): Promise<void> {
    if (this.stillBusy) return;
    this.stillBusy = true;
    try {
      const sink = await this.sink;
      while (!this.disposed && this.stillNext !== null) {
        const t = this.stillNext;
        this.stillNext = null;
        const started = performance.now();
        const sample = await sink.getSample(Math.max(0, t));
        if (this.disposed || this.stillNext !== null || this.stillAt !== t) {
          sample?.close();
          continue;
        }
        if (!sample) continue;
        // A frame of its own: the running decode no longer matches what is shown.
        this.stopRun();
        this.show(sample);
        tracePlayback("codec-still", { clip: this.label, at: Number(t.toFixed(3)), waitMs: Math.round(performance.now() - started) });
      }
    } catch (reason) {
      if (!this.disposed) tracePlayback("codec-error", { clip: this.label, error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      this.stillBusy = false;
    }
  }
}
