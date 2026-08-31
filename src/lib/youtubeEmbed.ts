import { getBridge } from "./bridge";
import { finishApiActivity } from "./activityLog";

export interface YoutubeEmbedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YoutubeEmbedStatus {
  ready: boolean;
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  position: number;
  duration: number;
  hasError: boolean;
}

export interface YoutubeEmbedControllerOptions {
  videoId: string;
  muted: boolean;
  bounds: YoutubeEmbedBounds;
  onStatus: (status: YoutubeEmbedStatus) => void;
  onError: (error: Error) => void;
}

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 100;
const PLAYING_POLL_MS = 250;

function abortError(): DOMException {
  return new DOMException("YouTube 播放会话已经结束", "AbortError");
}

function messageError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/**
 * One native official-player session. Readiness polling only observes the one navigation; it never
 * substitutes another client, URL, extractor, or playback request after a failure.
 */
export class YoutubeEmbedController {
  readonly done: Promise<void>;

  private readonly bridge = getBridge().youtubeEmbed;
  private readonly abort = new AbortController();
  private timer = 0;
  private ready = false;
  private disposed = false;

  constructor(private readonly options: YoutubeEmbedControllerOptions) {
    const started = performance.now();
    this.done = this.initialize().then(
      () => {
        finishApiActivity(
          {
            category: "network",
            action: "官方视频在线播放",
            target: "YouTube · youtube.com",
          },
          { status: 200, durationMs: performance.now() - started, ok: true },
        );
      },
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          finishApiActivity(
            {
              category: "network",
              action: "官方视频在线播放",
              target: "YouTube · youtube.com",
            },
            {
              status: 0,
              durationMs: performance.now() - started,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        throw error;
      },
    );
  }

  private async initialize(): Promise<void> {
    if (!this.bridge) throw new Error("当前系统没有隔离的 YouTube 官方播放器");
    await this.bridge.open({
      videoId: this.options.videoId,
      ...this.options.bounds,
    });
    const deadline = performance.now() + READY_TIMEOUT_MS;
    while (!this.abort.signal.aborted && performance.now() < deadline) {
      const status = await this.bridge.status(this.options.videoId);
      this.options.onStatus(status);
      if (status.hasError) throw new Error("YouTube 官方播放器拒绝了这个视频");
      if (status.ready) {
        if (this.options.muted) {
          await this.bridge.control(this.options.videoId, "mute");
        }
        this.ready = true;
        this.scheduleStatusPoll();
        return;
      }
      await delay(READY_POLL_MS, this.abort.signal);
    }
    if (this.abort.signal.aborted) throw abortError();
    throw new Error("YouTube 官方播放器启动超时");
  }

  private scheduleStatusPoll(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.pollStatus(), PLAYING_POLL_MS);
  }

  private async pollStatus(): Promise<void> {
    if (this.disposed || !this.bridge) return;
    try {
      const status = await this.bridge.status(this.options.videoId);
      if (this.disposed) return;
      this.options.onStatus(status);
      if (!status.ready || status.hasError) {
        throw new Error("YouTube 官方播放器中断了播放");
      }
      this.scheduleStatusPoll();
    } catch (reason) {
      if (this.disposed) return;
      this.options.onError(messageError(reason));
    }
  }

  async play(): Promise<void> {
    await this.done;
    if (this.disposed || !this.ready || !this.bridge) throw abortError();
    await this.bridge.control(this.options.videoId, "play");
  }

  async pause(): Promise<void> {
    await this.done;
    if (this.disposed || !this.ready || !this.bridge) throw abortError();
    await this.bridge.control(this.options.videoId, "pause");
  }

  async seek(position: number): Promise<void> {
    await this.done;
    if (this.disposed || !this.ready || !this.bridge) throw abortError();
    await this.bridge.control(this.options.videoId, "seek", position);
  }

  async setBounds(bounds: YoutubeEmbedBounds): Promise<void> {
    if (this.disposed || !this.bridge) return;
    await this.bridge.setBounds({ videoId: this.options.videoId, ...bounds });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    window.clearTimeout(this.timer);
    void this.bridge?.close(this.options.videoId).catch(() => undefined);
  }
}

export function prewarmYoutubeEmbed(): void {
  void getBridge().youtubeEmbed?.prewarm().catch(() => undefined);
}
