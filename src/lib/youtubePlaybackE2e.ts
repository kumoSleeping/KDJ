import type { SongSource } from "../types";
import { api } from "./api";
import { getBridge } from "./bridge";
import { sanitizeYoutubePlaybackE2eError } from "./youtubePlaybackE2eFailure";

const FIRST_VIDEO_ID = "aqz-KE-bpKQ";
const SECOND_VIDEO_ID = "dQw4w9WgXcQ";
const MEDIA_TIMEOUT_MS = 45_000;

interface VideoMeasurement {
  playableMs: number;
  advancingMs: number;
  durationSeconds: number;
}

interface YoutubePlaybackE2eResult {
  status: "running" | "passed" | "failed";
  stage: string;
  startupPrewarmMs?: number;
  coldVideo?: VideoMeasurement;
  seekMs?: number;
  switchedVideo?: VideoMeasurement;
  warmVideo?: VideoMeasurement;
  ytmAudioPlayableMs?: number;
  ytmAudioAdvancingMs?: number;
  error?: string;
}

function rounded(value: number): number {
  return Math.round(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function report(result: YoutubePlaybackE2eResult): Promise<void> {
  document.title = `KDJ YouTube E2E · ${result.status} · ${result.stage}`;
  let host = document.getElementById("kdj-youtube-e2e-result");
  if (!host) {
    host = document.createElement("pre");
    host.id = "kdj-youtube-e2e-result";
    host.style.cssText = [
      "position:fixed",
      "inset:24px",
      "z-index:2147483647",
      "overflow:auto",
      "margin:0",
      "padding:24px",
      "background:#111",
      "color:#e8e8e8",
      "font:14px/1.6 ui-monospace,monospace",
      "white-space:pre-wrap",
    ].join(";");
    document.body.append(host);
  }
  host.textContent = JSON.stringify(result, null, 2);
  const { baseUrl, authToken } = getBridge();
  const response = await fetch(`${baseUrl}/api/dev/youtube-playback-e2e-report`, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(result),
  });
  if (!response.ok) throw new Error("YouTube E2E 状态持久化失败");
}

function waitForEvent(
  media: HTMLMediaElement,
  names: string[],
  timeoutMs = MEDIA_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      for (const name of names) media.removeEventListener(name, onReady);
      media.removeEventListener("error", onError);
      error ? reject(error) : resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error(`媒体错误 ${media.error?.code ?? "unknown"}`));
    const timer = window.setTimeout(
      () => finish(new Error(`${names.join("/")} 超时`)),
      timeoutMs,
    );
    for (const name of names) media.addEventListener(name, onReady, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

async function waitForAdvance(media: HTMLMediaElement, seconds = 0.6): Promise<void> {
  const start = media.currentTime;
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    if (!media.paused && media.currentTime >= start + seconds) return;
    if (media.error) throw new Error(`媒体错误 ${media.error.code}`);
    await sleep(100);
  }
  throw new Error("YouTube Music 媒体时钟未继续前进");
}

function testAudioElement(): HTMLAudioElement {
  const audio = document.createElement("audio");
  audio.muted = true;
  audio.autoplay = false;
  audio.preload = "auto";
  audio.crossOrigin = "anonymous";
  audio.controls = true;
  audio.style.cssText = [
    "position:fixed",
    "left:32px",
    "bottom:32px",
    "z-index:2147483647",
    "width:320px",
    "height:36px",
    "opacity:1",
  ].join(";");
  document.body.append(audio);
  return audio;
}

type VideoPipStore = typeof import("./videoPip").useVideoPip;

function dispatchVideo(videoId: string): void {
  window.dispatchEvent(
    new CustomEvent("kd:video-preview", {
      detail: {
        platform: "youtube",
        bvid: videoId,
        page: 0,
        title: `KDJ YouTube E2E · ${videoId}`,
        author: "KDJ E2E",
      },
    }),
  );
}

async function waitForIntegratedVideo(
  store: VideoPipStore,
  videoId: string,
  startedAt: number,
): Promise<VideoMeasurement> {
  const deadline = performance.now() + MEDIA_TIMEOUT_MS;
  let playableAt = 0;
  let advancingFrom: number | null = null;
  while (performance.now() < deadline) {
    const pip = store.getState();
    if (pip.error) throw new Error(pip.error);
    if (
      pip.session?.source === "network" &&
      pip.session.platform === "youtube" &&
      pip.session.bvid === videoId
    ) {
      if (!playableAt && pip.duration > 0) playableAt = performance.now();
      if (pip.playing) {
        if (advancingFrom === null) advancingFrom = pip.position;
        if (pip.position >= advancingFrom + 0.6) {
          return {
            playableMs: rounded((playableAt || performance.now()) - startedAt),
            advancingMs: rounded(performance.now() - startedAt),
            durationSeconds: rounded(pip.duration),
          };
        }
      }
    }
    await sleep(100);
  }
  throw new Error("YouTube 官方播放器没有开始走时钟");
}

async function seekIntegratedVideo(store: VideoPipStore): Promise<number> {
  const before = store.getState();
  const upperBound = before.duration > 4 ? before.duration - 2 : 30;
  const target = Math.max(1, Math.min(60, upperBound));
  const startedAt = performance.now();
  window.dispatchEvent(
    new CustomEvent("kd:video-pip-seek", { detail: { position: target } }),
  );
  const deadline = performance.now() + 15_000;
  let reachedAt: number | null = null;
  let reachedPosition = 0;
  while (performance.now() < deadline) {
    const pip = store.getState();
    if (pip.error) throw new Error(pip.error);
    if (reachedAt === null && Math.abs(pip.position - target) <= 2.5) {
      reachedAt = performance.now();
      reachedPosition = pip.position;
    }
    if (reachedAt !== null && pip.playing && pip.position >= reachedPosition + 0.4) {
      return rounded(reachedAt - startedAt);
    }
    await sleep(100);
  }
  throw new Error("YouTube 官方播放器拖动后没有继续播放");
}

async function runIntegratedVideoSequence(): Promise<{
  cold: VideoMeasurement;
  seekMs: number;
  switched: VideoMeasurement;
  warm: VideoMeasurement;
}> {
  const [{ createElement }, { createRoot }, { VideoPipHost }, { useVideoPip }] =
    await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../components/player/VideoPipHost"),
      import("./videoPip"),
    ]);
  const host = document.createElement("div");
  host.id = "kdj-youtube-e2e-pip-host";
  host.style.cssText = "position:relative;z-index:2147483647";
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(VideoPipHost));
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const coldStartedAt = performance.now();
    dispatchVideo(FIRST_VIDEO_ID);
    const cold = await waitForIntegratedVideo(useVideoPip, FIRST_VIDEO_ID, coldStartedAt);
    const seekMs = await seekIntegratedVideo(useVideoPip);

    const switchedStartedAt = performance.now();
    dispatchVideo(SECOND_VIDEO_ID);
    const switched = await waitForIntegratedVideo(
      useVideoPip,
      SECOND_VIDEO_ID,
      switchedStartedAt,
    );

    const warmStartedAt = performance.now();
    dispatchVideo(FIRST_VIDEO_ID);
    const warm = await waitForIntegratedVideo(useVideoPip, FIRST_VIDEO_ID, warmStartedAt);
    return { cold, seekMs, switched, warm };
  } finally {
    useVideoPip.getState().clear();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    root.unmount();
    host.remove();
  }
}

async function measureYtmAudio(): Promise<{ playableMs: number; advancingMs: number }> {
  const source: SongSource = {
    platform: "ytm",
    key: SECOND_VIDEO_ID,
    title: "YouTube Music E2E",
    artists: ["KDJ E2E"],
    album: "",
    duration: null,
    cover: "",
    max_quality: null,
    vip: false,
    payload: { video_id: SECOND_VIDEO_ID },
  };
  const startedAt = performance.now();
  const preview = await api.songPreview(source, false);
  const audio = testAudioElement();
  try {
    const playable = waitForEvent(audio, ["loadeddata", "canplay"]);
    audio.src = preview.url;
    audio.load();
    await playable;
    const playableMs = performance.now() - startedAt;
    const playRequestedAt = performance.now();
    await audio.play();
    await waitForAdvance(audio);
    return {
      playableMs: rounded(playableMs),
      advancingMs: rounded(playableMs + (performance.now() - playRequestedAt)),
    };
  } finally {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio.remove();
  }
}

/** Development-only acceptance inside the real Tauri shell, kept muted and non-activating. */
export async function runYoutubePlaybackE2e(): Promise<void> {
  const result: YoutubePlaybackE2eResult = { status: "running", stage: "startup-prewarm" };
  await report(result);
  try {
    const prewarmStartedAt = performance.now();
    const official = getBridge().youtubeEmbed;
    if (!official) throw new Error("当前系统没有隔离的 YouTube 官方播放器");
    await Promise.all([official.prewarm(), api.prewarmYtmPlayback()]);
    result.startupPrewarmMs = rounded(performance.now() - prewarmStartedAt);

    result.stage = "cold-video";
    await report(result);
    const video = await runIntegratedVideoSequence();
    result.coldVideo = video.cold;
    result.seekMs = video.seekMs;
    result.switchedVideo = video.switched;
    result.warmVideo = video.warm;

    result.stage = "ytm-audio";
    await report(result);
    const audio = await measureYtmAudio();
    result.ytmAudioPlayableMs = audio.playableMs;
    result.ytmAudioAdvancingMs = audio.advancingMs;
    result.status = "passed";
    result.stage = "complete";
    await report(result);
  } catch (error) {
    result.status = "failed";
    result.error = sanitizeYoutubePlaybackE2eError(error);
    await report(result);
    throw error;
  }
}
