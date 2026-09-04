import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Blend,
  Clapperboard,
  Disc3,
  Download,
  FolderOpen,
  Library,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RefreshCw,
  Shuffle,
  PictureInPicture2,
  SkipBack,
  SkipForward,
  Waypoints,
} from "lucide-react";
import { api } from "../../lib/api";
import { MIDI_LOAD_DECK_EVENT } from "../../lib/midiLibraryNav";
import { analyzePlaying } from "../../lib/autoAnalyze";
import {
  hasPrevious,
  markPlayed,
  pickNext,
  previewNext,
  stepBack,
  trackById,
  type PreferredCandidateGuard,
} from "../../lib/autoplay";
import type { PredictionPolicySnapshot } from "../../lib/nextCandidatePolicy";
import {
  djEngine,
  findMixStartTime,
  mixSeconds,
  mixStartFromDuration,
  useDjConfig,
} from "../../lib/djMix";
import {
  automaticTransitionRate,
  BEATS_PER_BAR,
  hasRoomForAlignedTransition,
  msUntilNextBoundary,
} from "../../lib/beatGridSync";
import { useAppStore } from "../../stores/appStore";
import { useCrossfade, deckGain } from "../../lib/crossfade";
import { useHarmonicScope } from "../../lib/harmonicScope";
import { useLyricsPrefs } from "../../lib/lyricsPrefs";
import { ensureOverlayPermission } from "../../lib/lyricsOverlay";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import { usePlayMode, type PlayMode } from "../../lib/playMode";
import {
  AUDIO_FOCUS_EVENT,
  announceAudioFocus,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import { formatDuration, isVideoTrack, thumbUrl } from "../../lib/format";
import {
  MEDIA_SYNC_EVENT,
  broadcastMediaSync,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import {
  cancelLocalVideoSeekPreview,
  hasLocalVideoSeekPresenter,
  holdLocalVideoSeekPosition,
  prepareLocalVideoSeek,
  previewLocalVideoSeek,
} from "../../lib/localVideoSeekBridge";
import { coordinateLocalVideoSeek } from "../../lib/localVideoSeekTiming";
import {
  claimStreamCacheRetry,
  isStreamTrack,
  isUnresolvedStreamTrack,
  mediaUrlForTrack,
  publishStreamTrack,
  publishStreamTrackState,
  readPublishedStreamPlayback,
  readPublishedStreamTrack,
  streamMeta,
  streamNextTrack,
  streamWaveformToken,
  streamWaveformTokenById,
  subscribeStreamMeta,
} from "../../lib/streamTrack";
import { playSongPreview } from "../../lib/songPreview";
import { enqueueMediaDownloads } from "../../lib/mediaActions";
import {
  networkVideoOwnsTransport,
  rememberedLocalVideoTrackId,
  requestLocalVideo,
  seekVideoPip,
  toggleVideoPip,
  useVideoPip,
} from "../../lib/videoPip";
import type { Track } from "../../types";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import { POSITION_EVENT, type PositionDetail } from "../library/TrackDetail";
import { PLAY_EVENT, parsePlayRequest, playTrack } from "../../lib/playTrack";
import { getPlayingTrack, setPlayingTrack } from "../../lib/playingTrack";
import { usePlayerShortcuts } from "../../lib/usePlayerShortcuts";
import {
  ARROW_KEY_LIST_STEP_EVENT,
  type ArrowKeyListStepDetail,
} from "../../lib/arrowKeyControl";
import {
  recordStreamAnalysisProgress,
  streamAnalysisPollDelay,
} from "../../lib/streamAnalysis";
import { recordStreamCacheProgress } from "../../lib/streamCacheProgress";
import { updateStreamCue } from "../../lib/streamCue";
import {
  cachedReleaseOverviewWaveform,
  mergeCachedStreamWaveform,
  mediaBufferedRanges,
  prefetchWaveform,
  updateStreamWaveform,
} from "../../lib/waveformCache";
import {
  usesLocalLibraryRecord,
} from "../../lib/playbackTrackSource";
import {
  PLAYER_COMMAND_EVENT,
  publishPlayerSession,
  type PlayerCommand,
  type PlayerSessionStatus,
} from "../../lib/playerSession";
import { DETAIL_EVENT } from "../library/TrackTable";
import { pointPatch, SEEK_EVENT, Waveform, type SeekDetail } from "../library/Waveform";
import {
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_DECK_DROP_TARGET_ATTR,
} from "../../lib/trackDrag";
import {
  finishSearchDrop,
  isSearchAudioDrag,
  readSearchDrop,
  searchAudioSource,
} from "../../lib/searchDrag";
import {
  getLiveDeckPeak,
  runtimePlayer,
  usesNativeMobilePlayer,
} from "../../lib/unifiedPlayer";
import { bindTracksToPhysicalDecks } from "../../lib/deckTrackBinding";
import {
  playbackArtworkUrl,
  playbackSourceForTrack,
  ensurePlaybackTrackReady,
  hydratePlaybackTrack,
  resolvePlaybackTrack,
  songSourceRequest,
  subscribePlaybackTrackMetadata,
  trackIdRequest,
  type PlaybackTrackRequest,
} from "../../lib/playbackTrack";
import { decideNativeLatestIntent, LatestIntentGate } from "../../lib/latestIntentGate";
import {
  shouldBeginManagerTransition,
  shouldClearLocalVideoSessionForTrack,
  shouldRequestLocalVideoSessionForTrack,
} from "../../lib/playerTransitionPolicy";
import { LyricsHost } from "./LyricsHost";
import { nextLoadedDeckIndex, performanceLoadDeckIndex } from "../../lib/performanceCues";
import { readLocalStorage, writeLocalStorageSoon } from "../../lib/storageWrite";
import { useMasterVolume } from "../../lib/masterVolume";
import {
  playerVolumeMeterClipping,
  playerVolumeMeterLevel,
  playerVolumeMeterLagMs,
  smoothPlayerVolumeMeter,
} from "../../lib/playerVolumeMeter";

/** 广播播放位置的节流间隔：节拍网格的播放头不需要每帧更新。 */
const POSITION_BROADCAST_MS = 200;
/** 在线波形前台约 15fps；窗口后台只保留 4fps 的真实 analyser 采样。 */
const STREAM_WAVEFORM_FOREGROUND_MS = 66;
const STREAM_WAVEFORM_BACKGROUND_MS = 250;
/** 后端缓存波形只在当前在线曲目上短轮询；它不触发第二个媒体下载。 */
const STREAM_CACHE_WAVEFORM_POLL_MS = 750;
/** 缓存尚未预约时保持低频观察；明确的 failed 终态会直接释放轮询租约。 */
const STREAM_CACHE_WAVEFORM_IDLE_POLL_MS = 3_000;
/** macOS/Windows 可能同时从原生媒体会话和 WebView 报告同一次媒体键。 */
const SYSTEM_MEDIA_DEDUPE_MS = 180;

interface StreamAnalysisPollSubscriber {
  duration(): number;
  ended(): boolean;
}

interface StreamAnalysisPollSession {
  token: string;
  track: Track;
  subscribers: Set<StreamAnalysisPollSubscriber>;
  timer: number | null;
  inflight: boolean;
  disposed: boolean;
  terminal: boolean;
  lastRevision: number;
}

/** Manager view of the two low-level playback Decks. The public performance surface is gone,
 * but retaining this neutral projection keeps handoff/preload state out of React media elements. */
interface PerformanceDeckModel {
  track: Track | null;
  position: number;
  duration: number;
  active: boolean;
  playing: boolean;
  transportRunning: boolean;
  peakLevel: number;
  rate: number;
  audibleRate: number;
  scratchHeld: boolean;
  discontinuityRevision: number;
  cover: string;
  loopStart: number | null;
  loopLength: number | null;
  effectiveLoopStart: number | null;
  effectiveLoopLength: number | null;
  effectiveLoopGeneration: number;
}

/** One token owns one poller even when the manager and both Performance Decks observe it. */
const streamAnalysisPollers = new Map<number, StreamAnalysisPollSession>();

function subscribeStreamAnalysisPoll(
  track: Track,
  token: string,
  subscriber: StreamAnalysisPollSubscriber,
): () => void {
  const existing = streamAnalysisPollers.get(track.id);
  if (existing && existing.token !== token) {
    existing.disposed = true;
    if (existing.timer !== null) window.clearTimeout(existing.timer);
    streamAnalysisPollers.delete(track.id);
  }
  let session = streamAnalysisPollers.get(track.id);
  if (!session) {
    session = {
      token,
      track,
      subscribers: new Set(),
      timer: null,
      inflight: false,
      disposed: false,
      terminal: false,
      lastRevision: -1,
    };
    streamAnalysisPollers.set(track.id, session);
  }
  session.track = track;
  session.subscribers.add(subscriber);

  const totalDuration = () => {
    const observed = [...session!.subscribers]
      .map((item) => item.duration())
      .filter((value) => Number.isFinite(value) && value > 0);
    return Math.max(track.duration ?? 0, ...observed, 0);
  };
  const schedule = (delay: number) => {
    if (session!.disposed || session!.subscribers.size === 0) return;
    if (session!.timer !== null) window.clearTimeout(session!.timer);
    session!.timer = window.setTimeout(poll, delay);
  };
  const poll = () => {
    session!.timer = null;
    if (session!.inflight || session!.disposed) return;
    session!.inflight = true;
    void api.songPreviewWaveform(token)
      .then((progress) => {
        if (session!.disposed) return;
        recordStreamCacheProgress(track.id, progress);
        recordStreamAnalysisProgress(track.id, progress);
        if (progress.waveform && progress.revision > session!.lastRevision) {
          const total = totalDuration();
          const covered = Math.min(total, Math.max(0, progress.covered_seconds));
          mergeCachedStreamWaveform(
            track.id,
            total,
            progress.covered_seconds,
            progress.waveform,
            progress.revision,
            covered > 0 ? [{ start: 0, end: covered }] : [],
            progress.complete,
          );
          session!.lastRevision = progress.revision;
        }
        const allEnded = [...session!.subscribers].every((item) => item.ended());
        const delay = streamAnalysisPollDelay(
          progress,
          allEnded,
          STREAM_CACHE_WAVEFORM_POLL_MS,
          STREAM_CACHE_WAVEFORM_IDLE_POLL_MS,
        );
        session!.terminal = delay === null;
        if (delay !== null) schedule(delay);
      })
      .catch(() => {
        // A transient token/proxy miss must not permanently sever a Deck's analysis lease.
        schedule(STREAM_CACHE_WAVEFORM_IDLE_POLL_MS);
      })
      .finally(() => {
        session!.inflight = false;
      });
  };
  if (session.timer === null && !session.inflight && !session.terminal) poll();

  return () => {
    session!.subscribers.delete(subscriber);
    if (session!.subscribers.size > 0) return;
    session!.disposed = true;
    if (session!.timer !== null) window.clearTimeout(session!.timer);
    if (streamAnalysisPollers.get(track.id) === session) streamAnalysisPollers.delete(track.id);
  };
}

type SystemMediaAction = "play" | "pause" | "toggle" | "next" | "previous";

/**
 * 播放模式按钮的脸。一颗按钮循环切换，图标就是当前模式——
 * 图标选的都是播放器世界的通用语（循环/单曲循环/随机），只有调性接歌
 * 没有现成符号，用「路径点」表达"沿着和声关系往下走"。
 */
const MODE_UI: Record<PlayMode, { icon: typeof Repeat; label: string; hint: string }> = {
  harmonic: { icon: Waypoints, label: "调性接歌", hint: "放完自动接调性 / BPM 合拍的下一首" },
  order: { icon: Repeat, label: "顺序播放", hint: "按列表顺序放，到头绕回第一首" },
  shuffle: { icon: Shuffle, label: "随机播放", hint: "在范围内随机挑，优先没放过的" },
  one: { icon: Repeat1, label: "单曲循环", hint: "一直放这一首；手动按下一首仍会换歌" },
};

/** 跑马灯速度（px/s）。再快像广告牌，再慢会让人以为界面卡住了。 */
const MARQUEE_SPEED = 40;
/**
 * 一个来回的周期里"在走"占的比例（单程 35%），剩下的是两端的停顿——
 * 停顿是留给人读字的，不停的跑马灯一句话都读不完。
 * 只有当 design.css 的 @keyframes kd-marquee 真的按 --kd-marquee-time 计时时
 * 这个数才有意义，两边的百分比要对得上；那边现在写的是固定时长，
 * 变量给了它用不用是那边的事，用不上也不会出错。
 */
const MARQUEE_TRAVEL = 0.35;

/**
 * 一行会被正确裁切的字：真的放不下时才横向滚动。
 *
 * 踩过的两个坑：
 * 1. 这里原来直接是个 <span>，而**行内元素不吃 overflow:hidden / width**——
 *    长曲名会一路铺出去，盖在右边的圆形播放键上，键都按不着。
 *    所以外壳必须有 display:block 的效果（.kd-player-title / .kd-player-artist
 *    的 display:block 在 design.css 里）。
 * 2. CSS 判断不了"放不放得下"，只能在 JS 里比 scrollWidth 和 clientWidth。
 *    量出来没溢出就一个像素都不动——短曲名乱滚比看不全更烦人。
 */
function MarqueeText({ className, text }: { className: string; text: string }) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  /** 溢出的像素数，0 = 放得下 = 不滚 */
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let alive = true;
    const measure = () => {
      // clientWidth 为 0 说明还没排上版（或者被藏起来了），这时量到的溢出是假的，
      // 会把短曲名也判成要滚
      if (!alive || !box.clientWidth) return;
      // text-overflow: ellipsis 会让外壳自己的 scrollWidth 在部分 Chromium 版本里
      // 被压成 clientWidth；量真正承载文字的内层，才能知道完整标题有多宽。
      const content = box.firstElementChild as HTMLElement | null;
      const over = (content?.scrollWidth ?? box.scrollWidth) - box.clientWidth;
      // 留 1px 容差：亚像素排版常常差零点几，不留就会有一批"抖一下"的假滚动
      setShift(over > 1 ? over : 0);
    };
    measure();
    // 换歌那一帧量到的宽度是**不准的**：曲名里的中日文字形要 Chromium 去系统字体里
    // 异步回退，回退完成后这行字会变宽（实测 533px → 573px，差的这 40px 正好是
    // 跑马灯永远滚不到的尾巴）。这条路上一个事件都听不到——字体栈里没有 @font-face，
    // document.fonts.ready 页面一加载就 resolve 了；连内层挂 ResizeObserver 都不响
    // （实测换字形一次回调都没有）。所以只能隔几帧自己再量一遍：
    // 下一帧接住绝大多数，400ms 那次兜底慢的。
    const frame = requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 400);
    // 容器变宽变窄（窗口 resize、面板拖动）靠 RO。用它而不是 window.resize：
    // 布局变了但窗口没变的情况它也接得住。
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [text]);

  // 把"要走多远、该走多久"按实际溢出量算好交给 CSS：关键帧是死的，
  // 只有这两个变量能让长曲名和短曲名滚得一样快、并且不多走一步空转。
  const style = shift
    ? ({
        "--kd-marquee-shift": `${-shift}px`,
        "--kd-marquee-time": `${Math.max(4, shift / (MARQUEE_SPEED * MARQUEE_TRAVEL)).toFixed(1)}s`,
      } as CSSProperties)
    : undefined;

  return (
    <span ref={boxRef} className={className} data-marquee={shift ? "true" : undefined} style={style}>
      <span className="kd-marquee">{text}</span>
    </span>
  );
}

interface PlayerDeckView {
  key: string;
  track: Track | null;
  title: string;
  subtitle: string;
  cover: string;
  video: boolean;
}

const PLAYER_DECK_MEMORY_KEY = "kd-player-decks";
interface PlayerDeckMemory {
  leftId: number | null;
  rightId: number | null;
  activeIndex: 0 | 1;
  positionTrackId: number | null;
  position: number;
}

function readPlayerDeckMemory(): PlayerDeckMemory {
  try {
    const raw = JSON.parse(readLocalStorage(PLAYER_DECK_MEMORY_KEY) ?? "null") as Partial<PlayerDeckMemory> | null;
    return {
      leftId: typeof raw?.leftId === "number" ? raw.leftId : null,
      rightId: typeof raw?.rightId === "number" ? raw.rightId : null,
      activeIndex: raw?.activeIndex === 1 ? 1 : 0,
      positionTrackId: typeof raw?.positionTrackId === "number" ? raw.positionTrackId : null,
      position:
        typeof raw?.position === "number" && Number.isFinite(raw.position) && raw.position >= 0
          ? raw.position
          : 0,
    };
  } catch {
    return { leftId: null, rightId: null, activeIndex: 0, positionTrackId: null, position: 0 };
  }
}

function playbackCoverUrl(track: Track): string {
  return playbackArtworkUrl(track);
}

function viewForTrack(track: Track): PlayerDeckView {
  const streaming = isStreamTrack(track);
  return {
    key: `${streaming ? "stream" : "library"}:${track.id}`,
    track,
    title: track.title || track.filename,
    subtitle: track.artist || "\u00a0",
    cover: playbackCoverUrl(track),
    video: isVideoTrack(track.format),
  };
}

/**
 * 一台真正的 deck：黑胶外圈 + 圆形封面标签。左右两台结构完全相同，
 * 正主只由 djEngine 的 frontIndex 决定，接歌后不会把唱片瞬移回左边。
 */
function PlayerDeck({
  side,
  view,
  active,
  spinning,
  transitioning,
  dropActive,
  detailEnabled,
  resolving = false,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  side: "left" | "right";
  view: PlayerDeckView | null;
  active: boolean;
  spinning: boolean;
  transitioning: boolean;
  dropActive: boolean;
  /** 竖屏时“下一首”只是预告，不能打开会盖住列表的详情 Sheet。 */
  detailEnabled: boolean;
  /** 在线直链解析中：封面标题已就位，媒体尚未可播。 */
  resolving?: boolean;
  onOpen(): void;
  onDragOver(event: React.DragEvent<HTMLElement>): void;
  onDragLeave(event: React.DragEvent<HTMLElement>): void;
  onDrop(event: React.DragEvent<HTMLElement>): void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [view?.key]);
  // 接歌途中也只保留这两个身份；真正交接完成后，父组件才交换 active。
  const stateLabel = resolving ? "加载中" : active ? "正在播放" : "下一首";
  return (
    <div
      className="kd-player-deck"
      data-side={side}
      data-active={active ? "true" : undefined}
      data-transitioning={transitioning ? "true" : undefined}
      data-resolving={resolving ? "true" : undefined}
      data-empty={!view ? "true" : undefined}
      data-drop-active={dropActive ? "true" : undefined}
      {...{ [TRACK_DECK_DROP_TARGET_ATTR]: side === "left" ? "0" : "1" }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* display:contents：碟片和文案继续参与外层 grid。 */}
      <button
        type="button"
        className="kd-player-deck-main"
        aria-label={
          view
            ? `${stateLabel}：${view.title}${detailEnabled ? "" : "（移动端详情不可打开）"}`
            : side === "left"
              ? "左唱盘空闲"
              : "右唱盘空闲"
        }
        aria-disabled={!detailEnabled || !view}
        disabled={!detailEnabled || !view}
        title={
          view
            ? detailEnabled
              ? `${stateLabel}：${view.title}`
              : `${stateLabel}：${view.title}（移动端请点正在播放的歌曲）`
            : "等待曲目"
        }
        onClick={onOpen}
      >
        <span className="kd-player-disc" aria-hidden="true">
          <span className="kd-player-disc-record" data-spinning={spinning ? "true" : undefined}>
            {view?.cover && !coverFailed ? (
              <img
                src={view.cover}
                alt=""
                referrerPolicy="no-referrer"
                onError={(event) => {
                  event.currentTarget.style.opacity = "0";
                  setCoverFailed(true);
                }}
                onLoad={(event) => {
                  event.currentTarget.style.opacity = "1";
                }}
              />
            ) : view?.video ? (
              <Clapperboard size={15} />
            ) : view ? (
              <Disc3 size={17} />
            ) : (
              <Music2 size={15} />
            )}
          </span>
        </span>
        <span className="kd-player-deck-copy">
          <span className="kd-player-deck-state">{stateLabel}</span>
          <MarqueeText className="kd-player-title" text={view?.title ?? "等待下一首"} />
          <MarqueeText className="kd-player-artist" text={view?.subtitle ?? "\u00a0"} />
        </span>
      </button>
    </div>
  );
}

export function PlayerBar() {
  const { portrait } = useLayoutSignals();
  const mobileNative = usesNativeMobilePlayer();
  const playerRuntime = runtimePlayer();
  const desktopNative = playerRuntime.kind === "desktop-native";
  const selected = useLibraryStore(selectSelectedTrack);
  const selectTrack = useLibraryStore((state) => state.selectTrack);
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const mode = usePlayMode((state) => state.mode);
  const cycleMode = usePlayMode((state) => state.cycleMode);
  const scope = useHarmonicScope((state) => state.scope);
  const setScope = useHarmonicScope((state) => state.setScope);
  const libraryFolder = useLibraryStore((state) => state.filter.folder);
  const librarySort = useLibraryStore((state) => state.filter.sort);
  const libraryOrder = useLibraryStore((state) => state.filter.order);
  const coplay = useCrossfade((state) => state.coplay);
  const fadeX = useCrossfade((state) => state.x);
  // “自动切歌”是一条完整链路：同一个开关既决定曲末是否续播，也决定播放中的
  // 双击/下一首是否由双 Deck 接手。此前这里只把续播 UI 点亮、却把混音硬编码关闭，
  // 所以所有显式换歌都必然退化为普通换源。
  const autoAdvance = useDjConfig((state) => state.enabled);
  const djEnabled = autoAdvance && !mobileNative;
  const djBars = useDjConfig((state) => state.bars);
  const applyInOutPoints = useDjConfig((state) => state.applyInOutPoints);
  const autoBeatSync = useDjConfig((state) => state.autoBeatSync);
  const toggleDjEnabled = useDjConfig((state) => state.toggleEnabled);
  const transportFade = usePlaybackPrefs((state) => state.transportFade);
  const timeDisplayMode = usePlaybackPrefs((state) => state.timeDisplayMode);
  const focusLibrary = useAppStore((state) => state.focusLibrary);
  const defaultQuality = useAppStore((state) => state.settings?.default_quality ?? null);
  const filterResonance = useAppStore((state) => state.settings?.filter_resonance ?? "high");
  const [enqueueBusy, setEnqueueBusy] = useState(false);
  const desktopLyricsOn = useLyricsPrefs((state) => state.desktopEnabled);
  const setDesktopLyricsOn = useLyricsPrefs((state) => state.setDesktopEnabled);
  const canDesktopLyrics = Boolean(window.kdj?.desktopLyrics);
  const pipMode = useVideoPip((state) => state.mode);
  const pipActive = useVideoPip((state) => state.active);
  const pipFailed = useVideoPip((state) => state.failed);
  const pipSystem = useVideoPip((state) => state.systemPip);
  const pipSession = useVideoPip((state) => state.session);
  const pipPosition = useVideoPip((state) => state.position);
  const pipDuration = useVideoPip((state) => state.duration);
  const pipPlaying = useVideoPip((state) => state.playing);
  const cyclePipMode = useVideoPip((state) => state.cycleMode);
  /**
   * 播放元素归 djEngine 所有——它手里有两台 deck，接歌时互换正主，
   * 这里只拿"当前正主"。不再自己渲染 <audio>：JSX 里的元素没法互换，
   * 换正主就得换 src，中间必有一声可闻的断口。
   */
  const [frontEl, setFrontEl] = useState<HTMLAudioElement>(() => djEngine.frontElement());
  const frontElRef = useRef(frontEl);
  const lastBroadcast = useRef(0);
  /** DJ 接歌换上来的曲目 id：换 src 的 effect 见到它就跳过（引擎已装好）。 */
  const djViaRef = useRef<number | null>(null);
  /** 正在挑歌/起手。曲末的自动触发一秒能来四次，不挡会叠出一摞过渡。 */
  const djBusyRef = useRef(false);
  /** Rust Deck 的解码/不变调准备是异步的；准备完成前不能再开第二场。 */
  const nativeDjBusyRef = useRef(false);
  const nativeDjGenerationRef = useRef(0);
  const nativeDjNextRef = useRef<(manual: boolean) => Promise<boolean>>(async () => false);
  /** 纯浏览器双 Deck 的异步解析/起播必须单飞。正式壳不走这条 owner。 */
  const hybridDjBusyRef = useRef(false);
  /**
   * 手动“下一首”必须单飞。Android 与桌面共用 Rust 双 Deck；第三次连点若在
   * prepare/handoff 尚未落地时再塞候选，会越过协调器唯一的 deferred 槽。
   * 后续点击由 latest-intent gate 保留，等当前 Deck 到达安全边沿再兑现。
   */
  const manualNextDispatchingRef = useRef(false);
  const manualNextTargetRef = useRef<number | null>(null);
  const nativeManualChainDepthRef = useRef(0);
  /** 每个原生 error episode 只放行一次用户主动“下一首”自救，避免错误态永久 pending。 */
  const nativeErrorEpisodeRef = useRef(false);
  const nativeErrorRecoveryAvailableRef = useRef(true);
  const canRunManualNextRef = useRef<() => boolean>(() => true);
  const runManualNextRef = useRef<() => Promise<void>>(async () => {});
  /** 每次新的用户播放意图都会递增；异步挑歌完成后必须仍属于同一意图。 */
  const playbackIntentRef = useRef(0);
  /** 浏览器 ended 事件没有原生状态边沿，整段挑歌/起播期间只允许处理一次。 */
  const endedAdvanceRef = useRef<{ trackId: number; intent: number } | null>(null);
  const remoteNextRef = useRef<() => Promise<void>>(async () => {});
  const remotePreviousRef = useRef<() => Promise<void>>(async () => {});
  const systemMediaActionRef = useRef<(action: SystemMediaAction) => void>(() => {});
  const lastSystemMediaAtRef = useRef(Number.NEGATIVE_INFINITY);
  const nativePreparedRef = useRef<{
    fromId: number;
    trackId: number;
    rate: number;
    cue: number;
  } | null>(null);
  /** 最近一次已被原生播放器确认的队列签名。 */
  const nativeQueueSignatureRef = useRef("");
  /** 已进入 commandTail、但尚未收到确认的队列签名。 */
  const nativeQueuePendingSignatureRef = useRef("");
  /** 当前 React 期望原生播放器持有的队列签名。 */
  const nativeQueueDesiredSignatureRef = useRef("");
  const nativeQueueRetryTimerRef = useRef<number | null>(null);
  const nativeQueueRetrySignatureRef = useRef("");
  const nativeQueueRetryCountRef = useRef(0);
  const [nativeQueueRetry, setNativeQueueRetry] = useState(0);
  const nativePrepareGenerationRef = useRef(0);
  /** 这首歌自动接歌挑不到候选：记下来别每次 timeupdate 都去问一遍后端。 */
  const djGaveUpRef = useRef<number | null>(null);
  /** 右侧空闲唱盘已经预告的候选；真正续播时交回 pickNext，随机模式也不会变卦。 */
  const predictedRef = useRef<Track | null>(null);
  /**
   * 预测生成时的策略代数。UI 可以在重算期间保留旧封面防闪烁，但 pickNext 必须
   * 核对 epoch/mode/scope，绝不能把旧模式下的候选真正送进 Deck。
   */
  const predictionEpochRef = useRef(0);
  const predictedPolicyRef = useRef<PredictionPolicySnapshot | null>(null);
  const predictionPolicyNow = (
    baseTrackId: number,
    epoch = predictionEpochRef.current,
  ): PredictionPolicySnapshot => {
    const currentMode = usePlayMode.getState().mode;
    const currentScope = useHarmonicScope.getState().scope;
    const filter = useLibraryStore.getState().filter;
    return {
      epoch,
      baseTrackId,
      mode: currentMode,
      scope: currentScope,
      folder: currentScope === "folder" ? filter.folder : "",
      sort: currentMode === "order" ? filter.sort : "",
      order: currentMode === "order" ? filter.order : "",
    };
  };
  const preferredPredictionGuard = (current: Track): PreferredCandidateGuard | null => {
    const generated = predictedPolicyRef.current;
    return generated
      ? { generated, current: predictionPolicyNow(current.id) }
      : null;
  };
  /**
   * 起手时机=「找器乐段」时，这首歌预先算出的起手点（秒）。
   * null = 没算出来（没波形/判不出人声退场），回退按长度倒推。
   */
  const djOutroRef = useRef<{ trackId: number; at: number | null }>({ trackId: -1, at: null });
  /**
   * 自动续播硬切下一首时：记下目标曲目 id。换 src 后若开关开着且有开始点，seek 过去。
   * 手动点播不置位，仍从曲头起。
   */
  const autoInOutCueRef = useRef<number | null>(null);

  // PlayerBar 因 HMR/连接态切换重挂载时，模块级主唱盘仍持有本地或在线曲目；
  // 从它起步可以避免先画出旧标题、真正 transport 却还是空的中间态。
  const [track, setTrack] = useState<Track | null>(
    () => getPlayingTrack() ?? readPublishedStreamTrack(),
  );
  const [restoredStreamPlayback] = useState(() => readPublishedStreamPlayback());
  const activeStreamTrackId = track && isStreamTrack(track) ? track.id : 0;
  const subscribeActiveStreamMeta = useCallback(
    (listener: () => void) => subscribeStreamMeta(activeStreamTrackId, listener),
    [activeStreamTrackId],
  );
  const readActiveStreamWaveformToken = useCallback(
    () => streamWaveformTokenById(activeStreamTrackId),
    [activeStreamTrackId],
  );
  const activeStreamWaveformToken = useSyncExternalStore(
    subscribeActiveStreamMeta,
    readActiveStreamWaveformToken,
    readActiveStreamWaveformToken,
  );
  /** 纯浏览器开发预览仍由 Web Audio 双 Deck 持有；正式 Tauri 壳不再切换 owner。 */
  const [browserDjSession, setBrowserDjSession] = useState(
    () => playerRuntime.kind === "browser-preview" && isStreamTrack(track),
  );
  // 桌面与 Android 的本地/在线音频始终由同一个 Rust coordinator 持有。跨
  // Rust→WebAudio 接管曾同时造成交接爆音、在线 seek 冷启动和渐变 transport 分叉。
  const nativePlayer = playerRuntime.kind === "browser-preview" ? null : playerRuntime;
  const [playing, setPlaying] = useState(false);
  const autoAdvanceRef = useRef(autoAdvance);
  autoAdvanceRef.current = autoAdvance;
  const toggleAutoAdvance = useCallback(() => {
    const next = !useDjConfig.getState().enabled;
    autoAdvanceRef.current = next;
    toggleDjEnabled();
  }, [toggleDjEnabled]);
  const [performanceDeckStates, setPerformanceDeckStates] = useState(
    () => playerRuntime.state().decks,
  );
  const playerVolume = useMasterVolume((state) => state.volume);
  const setSharedMasterVolume = useMasterVolume((state) => state.setVolume);
  const playerVolumeRef = useRef(playerVolume);
  const playerVolumeMeterRef = useRef<HTMLSpanElement | null>(null);
  /**
   * MASTER 是最终输出闸门，不能等 React effect 才同步到原生引擎。尤其是控制器把
   * 推子拉到 0 后紧接着装入另一台 Deck 时，装盘命令可能先进入 IPC；那会让新流以
   * 引擎默认的 100% 音量跑过一小段，随后才被 effect 静音。
   *
   * 在输入事件内先更新 ref 并立刻排入音量命令，后续 loadDeck 必定排在这个静音命令
   * 之后。effect 仍负责初次恢复、HMR 和 crossfade 变化时的权威重申。
   */
  const setMasterVolume = useCallback((rawVolume: number) => {
    const volume = Number.isFinite(rawVolume) ? Math.min(1, Math.max(0, rawVolume)) : 0;
    playerVolumeRef.current = volume;
    setSharedMasterVolume(volume);
    const effective = volume * deckGain(useCrossfade.getState().coplay, useCrossfade.getState().x);
    if (nativePlayer) void nativePlayer.setVolume(effective);
    else djEngine.setVolume(effective);
  }, [nativePlayer, setSharedMasterVolume]);
  const [position, setPosition] = useState(() =>
    track &&
    track.id < 0 &&
    restoredStreamPlayback?.trackId === track.id
      ? restoredStreamPlayback.position
      : 0,
  );
  const [duration, setDuration] = useState(() => track?.duration ?? 0);
  const [predicted, setPredicted] = useState<Track | null>(null);
  const [refreshingPrediction, setRefreshingPrediction] = useState(false);
  /** 只在首次恢复会话唱盘时用 localStorage 里的另一台；改范围/模式后必须重新预测。 */
  const useRetainedNextOnceRef = useRef(true);
  const deckMemoryRef = useRef<PlayerDeckMemory>(readPlayerDeckMemory());
  const restoredPositionRef = useRef<{ trackId: number; position: number } | null>(
    track && track.id < 0 && restoredStreamPlayback?.trackId === track.id
      ? { trackId: track.id, position: restoredStreamPlayback.position }
      : null,
  );
  const [retainedDecks, setRetainedDecks] = useState<[Track | null, Track | null]>([null, null]);
  /** 明确拖到 A/B 的曲目固定在指定唱盘；预测逻辑不能把它下一帧覆盖。 */
  const [performanceDeckOverrides, setPerformanceDeckOverrides] = useState<[
    Track | null,
    Track | null,
  ]>([null, null]);
  /** 直链尚未就绪时的乐观装盘：物理 Deck id 还没跟上，但唱盘必须立刻有反馈。 */
  const [performancePendingDecks, setPerformancePendingDecks] = useState<[
    Track | null,
    Track | null,
  ]>([null, null]);
  const dualDeck = false;
  useEffect(() => {
    if (dualDeck) return;
    setPerformancePendingDecks([null, null]);
  }, [dualDeck]);
  // Mode exit is presentation-only, but an online resolve or Deck load started on the DJ surface
  // must not arrive later and reclaim manager playback with a stale song. Epoch also fences a
  // quick manager → DJ re-entry, where a boolean-only guard would make the old request valid again.
  const performanceSurfaceActiveRef = useRef(dualDeck);
  const performanceSurfaceEpochRef = useRef(0);
  if (performanceSurfaceActiveRef.current !== dualDeck) {
    performanceSurfaceActiveRef.current = dualDeck;
    performanceSurfaceEpochRef.current += 1;
  }
  /** Channel fader × crossfader for each physical Deck; double-click replaces the quieter side. */
  const performanceChannelGainsRef = useRef<[number, number]>([
    1,
    1,
  ]);
  const loadPerformanceTrackRef = useRef<(
    side: 0 | 1,
    deckTrack: Track,
    autoplay: boolean,
    position?: number,
  ) => Promise<void>>(async () => {});
  const [retainedDecksLoaded, setRetainedDecksLoaded] = useState(false);
  const [visualActiveIndex, setVisualActiveIndex] = useState<0 | 1>(deckMemoryRef.current.activeIndex);

  useEffect(() => {
    if (!dualDeck || !track) return;
    const physicalSide = performanceDeckStates.findIndex((deck) => deck.trackId === track.id);
    if (physicalSide !== 0 && physicalSide !== 1) return;
    if (visualActiveIndexRef.current === physicalSide) return;
    visualActiveIndexRef.current = physicalSide;
    setVisualActiveIndex(physicalSide);
  }, [dualDeck, track?.id, performanceDeckStates[0].trackId, performanceDeckStates[1].trackId]);

  // 当前正主由已挂载的全局波形以可见优先级读取；这里只低优先级预取下一首。
  // 两者若同时冷启动，可见请求会抢先，预测曲不会排在当前曲前面。
  useEffect(() => {
    prefetchWaveform(predicted);
    // 在线后继只保留展示元数据；真正轮到播放时才向平台解析直链。
    // 否则暂停在一首在线曲目上也会产生用户未发起的平台请求。
  }, [track?.id, predicted?.id]);
  const visualActiveIndexRef = useRef<0 | 1>(deckMemoryRef.current.activeIndex);
  const [djTransition, setDjTransition] = useState(() => djEngine.transitionState());
  const [transitionVisual, setTransitionVisual] = useState<{
    outgoingIndex: 0 | 1;
    incomingIndex: 0 | 1;
    from: Track;
    next: Track;
  } | null>(null);
  const transitionVisualRef = useRef<typeof transitionVisual>(null);
  /**
   * 播放/STEM 这类瞬时消息走全局右下角浮层；这里只留一份给媒体会话
   * 判断是不是致命播放错误，不再插进底栏。
   */
  const [notice, setNoticeState] = useState("");
  const setNotice = useCallback((text: string) => {
    setNoticeState(text);
    if (text) useToastStore.getState().show(text);
    else useToastStore.getState().dismiss();
  }, []);
  const [browserMediaStatus, setBrowserMediaStatus] = useState<PlayerSessionStatus>("idle");
  /** 已恢复的在线曲目首次解析失败后，登录/联网再按播放可原地重走装源。 */
  const [sourceLoadEpoch, setSourceLoadEpoch] = useState(0);
  const [deckDropSide, setDeckDropSide] = useState<"left" | "right" | null>(null);

  useEffect(() => {
    const onLoad = (event: Event) => {
      const detail = (event as CustomEvent<{ side: 0 | 1; track: Track }>).detail;
      if ((detail?.side !== 0 && detail?.side !== 1) || !detail.track) return;
      void loadPerformanceTrackRef.current(
        detail.side,
        detail.track,
        useDjConfig.getState().playOnLoad,
      ).catch((error: unknown) => {
        setNotice(
          `装入 Deck ${detail.side === 0 ? "A" : "B"} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    window.addEventListener(MIDI_LOAD_DECK_EVENT, onLoad);
    return () => window.removeEventListener(MIDI_LOAD_DECK_EVENT, onLoad);
  }, []);

  useEffect(() => {
    if (!nativePlayer || nativePlayer.kind !== "desktop-native") return;
    void nativePlayer.setTransportFade(transportFade).catch((error: unknown) => {
      setNotice(`同步播放渐变设置失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [nativePlayer, transportFade]);

  useEffect(() => {
    void playerRuntime.setFilterResonance(filterResonance).catch((error: unknown) => {
      setNotice(`同步 FILTER 共振设置失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [filterResonance, playerRuntime]);

  // 给 [] 依赖的 PLAY_EVENT 监听读的镜像：拦截接歌要知道"现在在放谁"
  const trackRef = useRef<Track | null>(track);
  const playingRef = useRef(false);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const selectedRef = useRef(selected);
  /** UI 画出来的正主可能来自会话恢复/当前选中项，早于正式 track state。 */
  const currentAdvanceTrackRef = useRef<Track | null>(track);
  const currentAdvanceTrack = () => trackRef.current ?? currentAdvanceTrackRef.current;
  const manualNextGateRef = useRef<LatestIntentGate | null>(null);
  manualNextGateRef.current ??= new LatestIntentGate(
    () => canRunManualNextRef.current(),
    () => runManualNextRef.current(),
    (error) => {
      setNotice(`切换下一首失败：${error instanceof Error ? error.message : String(error)}`);
    },
  );
  useEffect(() => {
    trackRef.current = track;
    // 右侧歌词也需要知道当前的在线试听；曲库定位按钮会单独过滤负数临时曲目。
    setPlayingTrack(track);
    // 自动接歌直接提交双 Deck handoff，不会再经过 playTrack(audio) 那条清理路径。
    // 在新曲目成为 UI 正主的同一边沿撤掉旧本地视频会话；否则旧 session 会继续
    // 保留视频宿主，详情重渲染时还能把退场视频重新接回来。
    if (track) {
      const pip = useVideoPip.getState();
      const localSessionTrackId =
        pip.session?.source === "local" ? pip.session.trackId : null;
      if (
        shouldClearLocalVideoSessionForTrack(
          pip.session?.source ?? null,
          localSessionTrackId,
          track.id,
          isVideoTrack(track.format),
        )
      ) {
        pip.clear();
      }
    }
    // 独立桌面歌词 WebView 不共享主窗状态；在线试听使用负数播放 id，
    // 需要显式发布完整曲目快照。
    publishStreamTrack(track && track.id < 0 ? track : null);
    setBrowserMediaStatus(
      track && isUnresolvedStreamTrack(track)
        ? "resolving"
        : track && isStreamTrack(track)
          ? "loading"
          : "idle",
    );
  }, [track]);

  // 在线完整分析回填后，当前唱盘也换成与本地曲目相同的 Track 元数据契约。
  // 详情、节拍网格、调号/Tempo 读数和后继策略因此共用同一份 BPM/Key/Grid，
  // 而不是只有 Analysis 面板看得到临时结果。
  useEffect(() => {
    if (!track || !isStreamTrack(track)) return;
    const sourceTrack = track;
    const hydrate = () => {
      void hydratePlaybackTrack(sourceTrack).then((next) => {
        if (next === sourceTrack || trackRef.current?.id !== sourceTrack.id) return;
        trackRef.current = next;
        setTrack(next);
      });
    };
    hydrate();
    return subscribePlaybackTrackMetadata(sourceTrack, hydrate);
  }, [track?.id]);

  useEffect(() => {
    const fatal = /播放失败|放不了|解析失败|无法播放/.test(notice);
    const status: PlayerSessionStatus = !track
      ? "idle"
      : fatal
        ? "error"
        : isStreamTrack(track) && browserMediaStatus !== "idle"
          ? browserMediaStatus
          : playing
            ? "playing"
            : "paused";
    publishPlayerSession({
      trackId: track?.id ?? null,
      status,
      playing,
      position,
      duration,
      error: fatal ? notice : "",
    });
  }, [track?.id, playing, position, duration, notice, browserMediaStatus]);
  // 独立歌词窗可能在主窗发布快照之后才创建；让它主动请求一次当前曲目/时钟，
  // 不依赖跨 WKWebView 的 localStorage 是否可见，也不依赖事件是否错过。
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen("stream-state-request", () => {
      const current = trackRef.current;
      if (!current || current.id >= 0) {
        publishStreamTrack(null);
        return;
      }
      const audio = frontElRef.current;
      publishStreamTrack(current);
      publishStreamTrackState(
        current,
        djEngine.currentTime(audio),
        playingRef.current,
        audio.playbackRate,
      );
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    frontElRef.current = frontEl;
  }, [frontEl]);
  /**
   * UI 刚提交暂停的时刻。移动端 state.playing 是硬件真值（isPlaying），pause 命令
   * 在原生侧排队生效前仍会滴答出几帧 playing=true；订阅里的"拉回播放"对账必须在
   * 这个短窗口内闭嘴，否则会把用户的暂停撤销掉（拉回还会触发 effect 重发 play）。
   */
  const pauseCommitAtRef = useRef(0);
  /** 播放状态既给 React 渲染，也给同一用户手势里的下一次事件判断；必须同步写 ref。 */
  const commitPlaying = useCallback((next: boolean) => {
    if (!next) pauseCommitAtRef.current = performance.now();
    playingRef.current = next;
    setPlaying(next);
  }, []);
  /** 换曲/外部同步仍由 effect 执行；主按钮已在 click 调用栈内直接完成走带。 */
  const transportHandledRef = useRef(false);
  const sourceReplacementFenceRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * 主按钮最近一次指针接触的时刻。Android WebView 无视 pointerdown 的 preventDefault
   * 照样合成 click（detail 值还不可靠），只能按"这个 click 是否紧跟一次指针手势"
   * 来吞重复；键盘激活没有指针手势，不受影响。
   */
  const transportPointerAtRef = useRef(0);
  /** shadow deck 异步换手时，连续点击只有最后一个目标能更新正主元素。 */
  const seekGenerationRef = useRef(0);
  /**
   * 视频有多份呈现（浮窗、详情、系统 PiP），同一次校时可能经 seeked 再回到这里。
   * 去重必须放在真正调用音频引擎的边界，而不能只相信任一 UI 的 suppress 标记。
   */
  const lastCommittedSeekRef = useRef<{ trackId: number; position: number; at: number } | null>(null);
  const shouldCommitSeek = useCallback(
    (trackId: number, position: number, force = false) => {
      const now = performance.now();
      const previous = lastCommittedSeekRef.current;
      if (
        !force &&
        previous &&
        previous.trackId === trackId &&
        now - previous.at < 750 &&
        // 回声落地时视频已经继续走了几十到几百毫秒，不能只按浮点完全相等去重。
        // 真正的快速跳远仍远大于 1 秒，会正常提交。
        Math.abs(previous.position - position) < 1
      ) {
        return false;
      }
      lastCommittedSeekRef.current = { trackId, position, at: now };
      return true;
    },
    [],
  );
  /** 已提交、等待后端落地的跳转；期间迟到的旧位置事件不能把进度条弹回去。 */
  const pendingSeekRef = useRef<{ trackId: number; position: number; at: number } | null>(null);
  /** 原生 seek 单飞：请求槽只保留最后一个目标，避免 Android commandTail 被连续点击填满。 */
  const nativeSeekRequestRef = useRef<{ trackId: number; position: number } | null>(null);
  const nativeSeekInFlightRef = useRef(false);
  const nativeSeekDrainRef = useRef<() => void>(() => {});
  /**
   * 波形 scrub 拖动中（pointerdown→up/cancel，由波形显式发边界事件）。
   * 拖动期间权威时钟每 100ms 一拍，若不压制会把拖到一半的播放头从手底下
   * 顶回去；松手瞬间受控 range 的 value 若刚被时钟改写，提交的甚至是旧
   * 位置——这次拖动就被整个弹回。松手后的正式跳转由 pendingSeekRef 接管。
   */
  const scrubbingRef = useRef(false);
  /** 原生播放器换 source 会短暂回 idle；这不是用户/系统按了暂停。 */
  const nativeLoadInFlightRef = useRef(false);
  /** 快速连点换歌时，迟到的旧 decode 结果不能覆盖新曲目的 UI/transport。 */
  const nativeLoadGenerationRef = useRef(0);
  /** Load ACK 只代表协调器接单；目标 Deck 真正激活前必须继续压住旧 transport。 */
  const nativeLoadTargetRef = useRef<{ trackId: number; generation: number } | null>(null);
  /**
   * Local desktop playback is submitted directly from PLAY_EVENT. The track effect observes this
   * token and skips its legacy post-render Load, preserving one physical load per user intent.
   */
  const eagerManagerLoadRef = useRef<(next: Track, autoPlay: boolean) => boolean>(() => false);
  const eagerManagerLoadTokenRef = useRef<{ trackId: number; generation: number } | null>(null);
  /** 解析在线地址时旧 Deck 必须先停；这里单独保留“解析成功后自动播放”的意图。 */
  const deferredStreamAutoplayRef = useRef<number | null>(null);
  /** UI 已切到新曲、Rust 仍报告旧物理 Deck 的窗口。旧快照不得冒充新曲状态。 */
  const pendingTrackSwitchRef = useRef<{ trackId: number; intent: number } | null>(null);
  /** 桌面端 state.trackId 连续与 UI 曲目不一致的拍数；稳定分叉时以 UI 为准自愈。 */
  const nativeTrackMismatchRef = useRef(0);
  /** 同一首曲目的自愈补偿节流：补偿失败也不能每一拍都重发 load。 */
  const lastNativeHealRef = useRef<{ trackId: number; at: number } | null>(null);

  /**
   * 原生播放器只允许一个 seek 命令在途。协调器进入 Seeking/Loading 后，后续点击
   * 先停在槽里，等权威状态回到当前曲目且不再 buffering 时再发最后一个目标。
   * 这样既保留第一下的即时响应，也不会把一串过时位置排进 Tauri/Rust 队列。
   */
  const drainNativeSeek = useCallback(() => {
    const player = nativePlayer;
    const request = nativeSeekRequestRef.current;
    if (!player || !request || nativeSeekInFlightRef.current) return;

    const current = trackRef.current;
    if (!current || current.id !== request.trackId) {
      nativeSeekRequestRef.current = null;
      return;
    }
    const state = player.state();
    if (
      state.trackId !== request.trackId ||
      state.buffering ||
      state.status === "loading"
    ) {
      return;
    }

    nativeSeekRequestRef.current = null;
    nativeSeekInFlightRef.current = true;
    const target = request.position;
    // 旧曲目的状态边沿可能已清掉 pendingSeek；在真正发命令前重新 pin 一次。
    pendingSeekRef.current = { trackId: request.trackId, position: target, at: performance.now() };
    void player
      .seek(target)
      .catch(() => {
        // 失败时只清理仍指向这次目标的槽位；更晚的点击不能被旧错误抹掉。
        const latest = nativeSeekRequestRef.current;
        if (
          latest &&
          latest.trackId === request.trackId &&
          Math.abs(latest.position - target) < 0.001
        ) {
          nativeSeekRequestRef.current = null;
        }
        const pending = pendingSeekRef.current;
        if (
          pending &&
          pending.trackId === request.trackId &&
          Math.abs(pending.position - target) < 0.001
        ) {
          pendingSeekRef.current = null;
        }
      })
      .finally(() => {
        nativeSeekInFlightRef.current = false;
        // 若点击发生在本次命令确认前，沿用最新槽位；若状态仍在 Seeking，
        // drain 会自然等下一次 playback-state 边沿。
        nativeSeekDrainRef.current();
      });
  }, [nativePlayer]);
  nativeSeekDrainRef.current = drainNativeSeek;

  const requestNativeSeek = useCallback(
    (trackId: number, target: number) => {
      if (!nativePlayer) return;
      const position = Math.max(0, target);
      pendingSeekRef.current = { trackId, position, at: performance.now() };
      nativeSeekRequestRef.current = { trackId, position };
      nativeSeekDrainRef.current();
    },
    [nativePlayer],
  );

  const invalidateNativeSeek = useCallback(() => {
    nativeSeekRequestRef.current = null;
    pendingSeekRef.current = null;
  }, []);
  useEffect(() => () => invalidateNativeSeek(), [invalidateNativeSeek]);

  /**
   * 会话恢复只“装盘”，不擅自播放。把展示快照正式提升为 active track 后，
   * 换源 effect 会以 autoplay=false 预装媒体，播放键、快捷键和 SEEK_EVENT
   * 从首屏开始就走同一条正常 transport，不再各自猜 retainedDecks。
   */
  const restorePausedTrack = useCallback(
    (restored: Track, restoredIndex: 0 | 1, rememberedPosition: number) => {
      if (trackRef.current) return;
      const restoreVideoPresentation =
        isVideoTrack(restored.format) && rememberedLocalVideoTrackId() === restored.id;
      const duration = restored.duration ?? 0;
      const boundedPosition =
        Number.isFinite(rememberedPosition) && rememberedPosition > 0
          ? duration > 0
            ? rememberedPosition < Math.max(0, duration - 1)
              ? Math.min(rememberedPosition, duration)
              : 0
            : rememberedPosition
          : 0;
      trackRef.current = restored;
      positionRef.current = boundedPosition;
      durationRef.current = duration;
      restoredPositionRef.current = { trackId: restored.id, position: boundedPosition };
      visualActiveIndexRef.current = restoredIndex;
      setVisualActiveIndex(restoredIndex);
      setTrack(restored);
      setPosition(boundedPosition);
      setDuration(duration);
      commitPlaying(false);
      if (usesLocalLibraryRecord(restored)) selectTrack(restored);
      if (restoreVideoPresentation) {
        // VideoPipHost 的监听与 PlayerBar 同轮挂载；下一任务再恢复画面，既不丢事件，
        // 也不把上次的“正在播放”意图带回来——重启后一律停在记住的进度。
        window.setTimeout(() => {
          if (trackRef.current?.id === restored.id) requestLocalVideo(restored, false);
        }, 0);
      }
    },
    [commitPlaying, selectTrack],
  );

  // 上次退出时两台唱盘各留着哪一首，只存 id；恢复时重新取最新 Track，避免把
  // 分析前的旧 BPM / 封面版本快照跨会话带回来。曲目被删了就让预测逻辑补位。
  useEffect(() => {
    let alive = true;
    const memory = deckMemoryRef.current;
    void Promise.all([
      memory.leftId === null ? Promise.resolve(null) : trackById(memory.leftId),
      memory.rightId === null ? Promise.resolve(null) : trackById(memory.rightId),
    ]).then(([left, right]) => {
      if (!alive) return;
      setRetainedDecks([left, right]);
      setRetainedDecksLoaded(true);
      const active = memory.activeIndex === 0 ? left : right;
      const other = memory.activeIndex === 0 ? right : left;
      const restored = active ?? other;
      if (restored) {
        const rememberedPosition =
          memory.positionTrackId === restored.id ? memory.position : 0;
        restorePausedTrack(
          restored,
          active ? memory.activeIndex : memory.activeIndex === 0 ? 1 : 0,
          rememberedPosition,
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [restorePausedTrack]);

  // 声音引擎才知道新 deck 何时真正起播、旧 deck 何时真正停下；唱盘动画订阅
  // 同一条生命周期，避免用 CSS 秒数猜测而越播越不同步。
  useEffect(
    () =>
      djEngine.subscribeTransition((state) => {
        setDjTransition(state);
        if (state.phase === "idle") {
          const visual = transitionVisualRef.current;
          if (visual) {
            visualActiveIndexRef.current = visual.incomingIndex;
            setVisualActiveIndex(visual.incomingIndex);
          }
          transitionVisualRef.current = null;
          setTransitionVisual(null);
          const current = trackRef.current;
          if (current) {
            const source = mediaUrlForTrack(current);
            // 接歌刚结束时不要立刻整首 fetch + decodeAudioData。第一次 seek 与这份
            // 后台解码抢同一个 WebKit 媒体解码器，正是“自动过渡后必卡一次、后来
            // 正常”的稳定差异；直接点播提前解 PCM 的路径不变。接歌曲统一保留热的
            // HTMLMedia 管线，并只准备静音 shadow Deck。
            djEngine.releaseDecodedPlayback();
            djEngine.prepareSeek(source);
          }
          // Web Audio 没有 Rust 状态订阅；过渡真正收尾这一拍就是 pending next
          // 唯一可靠的重试边沿。
          manualNextGateRef.current?.wake();
        }
      }),
    [],
  );

  /**
   * DJ 过渡切到 next：引擎起手 + UI 立即切过去。返回 false = 引擎没接手
   * （预设关着 / 引擎不可用），调用方走硬切。
   *
   * UI 在过渡**开始**时就切而不是结束时切：换歌的人想看的是接进来的那首；
   * 旧歌在暗处按曲线退场，标题、波形、进度都已经是新歌的了。
   */
  const djSwitchTo = useCallback(
    (next: Track, from: Track): boolean => {
      // 移动端的播放 owner 是系统媒体服务，不让实时 DJ 再开第二条输出链。
      if (mobileNative) return false;
      const { enabled, transitions, effects, bars, vocalCut, applyInOutPoints, autoBeatSync } =
        useDjConfig.getState();
      if (!enabled) return false;
      // 在线占位曲也属于过渡链路：保持旧 Deck 出声，在下面异步解析应用内代理
      // URL，随后把新源预读进第二台 Deck。这里若按“还没有 src”提前拒绝，所有
      // 在线下一首都会退化成普通换源，Blend 按钮看起来就完全没有作用。
      const outgoingIndex = visualActiveIndexRef.current;
      const intent = playbackIntentRef.current;
      const stillCurrent = () =>
        playbackIntentRef.current === intent && trackRef.current?.id === from.id;
      const prepareIncomingVideoPresentation = () => {
        const pip = useVideoPip.getState();
        const sessionTrackId =
          pip.session?.source === "local" ? pip.session.trackId : null;
        if (
          shouldRequestLocalVideoSessionForTrack(
            pip.session?.source ?? null,
            sessionTrackId,
            next.id,
            isVideoTrack(next.format),
          )
        ) {
          // Direct Deck handoffs bypass playTrack/LOCAL_VIDEO. Establish the picture only after
          // the audio handoff succeeds, and let the authoritative player sync start it at the cue.
          requestLocalVideo(next, false);
        }
      };

      if (desktopNative && nativePlayer?.supportsRealtimeDj) {
        if (manualNextDispatchingRef.current) {
          // 一场正在混时只允许再承诺一场 deferred。更多连点留在前端 gate，
          // 不能把第三候选送进只有两台 Deck 的协调器再靠失败回退硬切。
          nativeManualChainDepthRef.current = nativePlayer.state().transitioning
            ? 2
            : Math.min(2, nativeManualChainDepthRef.current + 1);
          manualNextTargetRef.current = next.id;
        }
        // 在途 prepare/handoff 时再切一首：抬 generation 作废旧任务，开跑新候选。
        // 以前 busy 时 return true，调用方以为接歌成功，实际 noop →「切歌失败」。
        nativeDjBusyRef.current = true;
        const generation = ++nativeDjGenerationRef.current;
        const currentRate = nativePlayer.state().rate || 1;
        const effectiveFromBpm = from.bpm ? from.bpm * currentRate : null;
        // Automatic beat sync is an explicit user choice. A prepared Deck used to inherit this
        // computed rate even while the switch was off, so the next Manager song arrived with a
        // visibly random TEMPO value despite never entering a SYNC group.
        const rate = automaticTransitionRate(autoBeatSync, effectiveFromBpm, next.bpm);
        const tempo = effectiveFromBpm ?? next.bpm ?? 120;
        const seconds = mixSeconds(tempo, bars);
        const chosenTransitions = transitions.filter(() => Math.random() >= 0.5);
        if (!chosenTransitions.length && transitions.length) {
          chosenTransitions.push(transitions[Math.floor(Math.random() * transitions.length)]);
        }
        const cue =
          applyInOutPoints && next.cue_ms !== null
            ? next.cue_ms / 1000
            : (next.first_beat ?? 0);
        const handoffPlan = {
          eq: chosenTransitions.includes("eq"),
          filter: chosenTransitions.includes("filter"),
          vocalCut,
          echo: effects.includes("echo"),
          alarm: effects.includes("alarm"),
          hydrant: effects.includes("hydrant"),
          beatSeconds: 60 / Math.max(1, tempo),
        };
        const commitUi = () => {
          prepareIncomingVideoPresentation();
          const incomingIndex: 0 | 1 = outgoingIndex === 0 ? 1 : 0;
          const visual = { outgoingIndex, incomingIndex, from, next };
          transitionVisualRef.current = visual;
          setTransitionVisual(visual);
          focusLibrary();
          djViaRef.current = next.id;
          // React effect 要到下一帧才镜像 track；latest-intent gate 可能在同一微任务
          // 被唤醒，必须先同步正主，避免第二次仍从旧歌挑候选。
          trackRef.current = next;
          setTrack(next);
          if (usesLocalLibraryRecord(next)) selectTrack(next);
          setPosition(cue);
          setDuration(next.duration ?? 0);
          commitPlaying(true);
          setNotice("");
          markPlayed(next.id);
        };
        const hardCutFallback = async (message?: string): Promise<void> => {
          if (!stillCurrent()) return;
          transitionVisualRef.current = null;
          setTransitionVisual(null);
          setDjTransition({ phase: "idle", frontIndex: visualActiveIndexRef.current });
          djViaRef.current = null;
          if (useDjConfig.getState().applyInOutPoints) autoInOutCueRef.current = next.id;
          await nativePlayer
            .load({
              src: mediaUrlForTrack(next),
              track: next,
              position: cue,
              // A failed overlap is now an ordinary Manager replacement. There is no second Deck
              // left to synchronize to, so carrying the transition rate would only retune the UI.
              rate: 1,
              autoplay: true,
            })
            .then((state) => {
              // load 被更新的播放意图作废时会以 no-op 成功返回；不能让这个旧
              // fallback 继续提交 UI，把用户刚点的新曲目切回去。
              if (!stillCurrent()) return;
              if (state.status === "error") {
                throw new Error(state.error || "原生播放器无法播放这个文件");
              }
              prepareIncomingVideoPresentation();
              focusLibrary();
              trackRef.current = next;
              djViaRef.current = next.id;
              setTrack(next);
              if (usesLocalLibraryRecord(next)) selectTrack(next);
              setPosition(cue);
              setDuration(next.duration ?? 0);
              commitPlaying(true);
              markPlayed(next.id);
              setNotice("");
            })
            .catch((fallbackError: unknown) => {
              if (!stillCurrent()) return;
              if (manualNextTargetRef.current === next.id) {
                manualNextTargetRef.current = null;
                manualNextGateRef.current?.cancel();
              }
              setNotice(
                message ??
                  `接歌失败，硬切补偿也失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
              );
            });
        };
        void (async () => {
          try {
            if (generation !== nativeDjGenerationRef.current) return;
            // 在线搜索结果的后继项可能还只是元数据占位。先解析应用内代理 URL，
            // 旧 Rust Deck 在整个网络等待期继续出声；解析成功后仍由同一 coordinator
            // 预读/接歌，不再跨到 Web Audio。
            await ensurePlaybackTrackReady(next);
            if (generation !== nativeDjGenerationRef.current || !stillCurrent()) return;
            // 后台预热 ACK 只代表“命令已登记”，其 Deck 仍可能被随后到达的队列预热
            // 换成另一首。接歌前必须用最终候选再确认一次；prepare 对命中项幂等，
            // 对陈旧项则会重定向 Deck。跳过这步会让 handoff 找不到目标后走硬切，
            // 表现成混音时间一到进度瞬间划过、上一首直接消失。
            await nativePlayer.prepare({
              src: mediaUrlForTrack(next),
              track: next,
              position: cue,
              rate,
            });
            if (generation !== nativeDjGenerationRef.current || !stillCurrent()) return;
            if (autoBeatSync) {
              const handoffState = nativePlayer.state();
              const waitMs = msUntilNextBoundary(
                handoffState.currentTime,
                from.bpm,
                from.first_beat,
                handoffState.rate || currentRate,
                BEATS_PER_BAR,
              );
              // A user end point is the audible handoff deadline even though the decoder can
              // continue to the physical EOF. Also keep source seconds and wall seconds separate:
              // TEMPO changes how much of the source timeline one second of crossfade consumes.
              const transitionEnd = applyInOutPoints && from.end_ms != null
                ? Math.min(
                    handoffState.duration || from.duration || from.end_ms / 1_000,
                    from.end_ms / 1_000,
                  )
                : (handoffState.duration || from.duration || 0);
              const remainingSource = transitionEnd > 0
                ? Math.max(0, transitionEnd - handoffState.currentTime)
                : 0;
              // Near EOF the overlap itself is more important than waiting for another bar. The
              // former unconditional wait consumed up to one full bar after the auto trigger,
              // leaving no outgoing audio for the requested transition.
              const hasRoomForAlignedOverlap = hasRoomForAlignedTransition(
                remainingSource,
                handoffState.rate || currentRate,
                seconds,
                waitMs,
              );
              if (hasRoomForAlignedOverlap && waitMs != null) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
                if (generation !== nativeDjGenerationRef.current || !stillCurrent()) return;
              }
            }
            await nativePlayer.handoff(next.id, cue, seconds, handoffPlan);
            if (generation !== nativeDjGenerationRef.current || !stillCurrent()) return;
            commitUi();
          } catch (error: unknown) {
            if (generation !== nativeDjGenerationRef.current) return;
            await hardCutFallback(
              `原生接歌失败：${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            if (generation === nativeDjGenerationRef.current) {
              nativeDjBusyRef.current = false;
              manualNextGateRef.current?.wake();
            }
          }
        })();
        return true;
      }

      // 在线流可能还是搜索结果里的占位曲目。先在后台解析直链，再让第二台
      // Deck 起播；解析期间当前曲目继续出声，不把网络等待暴露成暂停。
      const commitBrowserUi = (cue: number) => {
        prepareIncomingVideoPresentation();
        const incomingIndex: 0 | 1 = outgoingIndex === 0 ? 1 : 0;
        const visual = { outgoingIndex, incomingIndex, from, next };
        transitionVisualRef.current = visual;
        setTransitionVisual(visual);
        focusLibrary();
        if (isStreamTrack(next) || isStreamTrack(from)) setBrowserDjSession(true);
        djViaRef.current = next.id;
        setFrontEl(djEngine.frontElement());
        trackRef.current = next;
        setTrack(next);
        if (usesLocalLibraryRecord(next)) selectTrack(next);
        setPosition(cue);
        setDuration(next.duration ?? 0);
        commitPlaying(true);
        setNotice("");
        markPlayed(next.id);
      };

      const browserTransition = async (): Promise<void> => {
        await ensurePlaybackTrackReady(next);
        if (!stillCurrent()) return;

        // This branch is the standalone browser adapter only. Native desktop/Android returned
        // through the coordinator branch above and can never fall back to a second audio owner.
        if (!stillCurrent()) return;
        const started = djEngine.begin(next, {
          transitions,
          effects,
          from,
          bars,
          vocalCut,
          applyInOutPoints,
          autoBeatSync,
        });
        if (!started) {
          djEngine.cancel();
          djEngine.hardPause(djEngine.frontElement());
          setNotice("接歌引擎暂不可用，保留当前播放");
          return;
        }
        commitBrowserUi(
          applyInOutPoints && next.cue_ms !== null
            ? next.cue_ms / 1000
            : (next.first_beat ?? 0),
        );
      };

      if (hybridDjBusyRef.current) return false;
      if (isStreamTrack(next) || isStreamTrack(from)) hybridDjBusyRef.current = true;
      void browserTransition()
        .catch((error: unknown) => {
          if (stillCurrent()) {
            setNotice(`在线接歌失败：${error instanceof Error ? error.message : String(error)}`);
          }
        })
        .finally(() => {
          hybridDjBusyRef.current = false;
          manualNextGateRef.current?.wake();
        });
      return true;
    },
    [mobileNative, desktopNative, nativePlayer, selectTrack, focusLibrary, commitPlaying],
  );

  // 曲库表格双击 / 在线试听 → 这里换曲并播放。用全局事件而不是共享 store，
  // 是为了让"能触发播放"的组件不必都知道播放器的存在。
  useEffect(() => {
    const onPlay = (event: Event) => {
      const parsed = parsePlayRequest((event as CustomEvent).detail);
      if (!parsed) return;
      const next = parsed.track;
      // 管理器模式的普通点播会重建单轨上下文；双盘会话必须保留另一台
      // 物理 Deck，不能因为双击一首歌就把两侧手动装盘状态一起清空。
      if (!dualDeck) {
        setPerformanceDeckOverrides([null, null]);
        setPerformancePendingDecks([null, null]);
      }
      const autoPlay = parsed.autoPlay !== false;
      if (!manualNextDispatchingRef.current) {
        // 双击指定曲目是比“稍后再下一首”更明确的新意图，不能让排队的连点
        // 在这首刚起播后又把它切走。
        manualNextGateRef.current?.cancel();
        manualNextTargetRef.current = null;
        nativeManualChainDepthRef.current = 0;
      }
      // 任何新播放请求都作废尚未落地的自动挑歌/在线桥接，避免迟到结果抢回用户刚点的曲目。
      invalidateNativeSeek();
      playbackIntentRef.current += 1;
      nativeDjGenerationRef.current += 1;
      nativeDjBusyRef.current = false;
      // PLAY_EVENT 通常由双击/右键等用户手势同步发出。趁手势仍有效唤醒
      // 刷新后 suspended 的 Web Audio 图，否则 audio 在走、扬声器却是静音。
      const webPreview = nativePlayer === null;
      if (autoPlay && webPreview) djEngine.resume();
      // 只有纯浏览器调试 adapter 使用 Web Audio；Tauri 桌面与 Android 的在线流
      // 和本地文件一样留在 Rust 输出，不再为一次点播切换音频 owner。
      if (webPreview && !useCrossfade.getState().coplay) {
        djEngine.setVolume(playerVolumeRef.current);
      }
      const isLocalVideo = isVideoTrack(next.format);
      const current = trackRef.current;
      // Freeze the route before the unresolved-source fence below can pause/clear the current
      // Deck. Provider resolution belongs inside a DJ handoff: the old song must remain audible
      // until the new stream is buffered and ready to overlap it.
      const wantsDjTransition = shouldBeginManagerTransition({
        autoPlay,
        currentPlaying: playingRef.current,
        transitionEnabled: useDjConfig.getState().enabled,
        realtimeTransitionAvailable: playerRuntime.supportsRealtimeDj,
        dualDeck,
        currentTrackId: current?.id ?? null,
        nextTrackId: next.id,
      });
      // 在线占位曲目的封面/标题会立刻换，但媒体 URL 还在 BotGuard/player 请求中。
      // 普通换源必须在 PLAY_EVENT 这一拍停掉旧 Deck；DJ handoff 则刻意保留它，
      // 否则第二台 Deck 即使稍后准备成功，也已经没有可供交叉渐变的退场音频。
      if (autoPlay && isUnresolvedStreamTrack(next) && !wantsDjTransition) {
        deferredStreamAutoplayRef.current = next.id;
        pendingTrackSwitchRef.current = {
          trackId: next.id,
          intent: playbackIntentRef.current,
        };
        // 在 React effect 与网络解析之前就立 fence。否则原生旧 Deck 的 10Hz 快照会把
        // 旧时长/旧播放态写到新标题下，1.5 秒对账还会把旧歌重新认成“正在播放”。
        nativeLoadInFlightRef.current = true;
        commitPlaying(false);
        playingRef.current = false;
        // Native and WebAudio can overlap during a handoff. Clear both ownership domains now;
        // pausing only Rust still leaves djEngine's preserved front Deck able to resume an old song.
        djEngine.clearAllPlayback();
        if (nativePlayer) {
          transportHandledRef.current = true;
          const fence = nativePlayer.interruptClear().then(() => undefined);
          sourceReplacementFenceRef.current = fence;
          void fence.catch(() => {
            transportHandledRef.current = false;
          });
        }
        else sourceReplacementFenceRef.current = Promise.resolve();
      } else {
        deferredStreamAutoplayRef.current = null;
        pendingTrackSwitchRef.current = null;
      }
      // 本地视频的 LOCAL_VIDEO 已在 playTrack 发出；这里只补面板档的详情栏。
      // 音频：playTrack 已 clear 预览会话；非流媒体仍进曲库详情。
      if (isLocalVideo) {
        if (useVideoPip.getState().mode === "panel" && !isStreamTrack(next)) {
          window.dispatchEvent(new Event(DETAIL_EVENT));
        }
      } else if (!isStreamTrack(next)) {
        // 音频起播只清设置/队列等旁路，不自动钉详情；歌词内容面要保留，
        // 否则双击刚钉住的歌词栏会被 showTrackDetail 的 clearOverlays 拆掉。
        focusLibrary();
      }
      if (dualDeck && nativePlayer?.supportsRealtimeDj) {
        const nativeDecks = nativePlayer.state().decks;
        const loadedSide = nativeDecks.findIndex((deck) => deck.trackId === next.id);
        const side = loadedSide === 0 || loadedSide === 1
          ? loadedSide
          : performanceLoadDeckIndex(
              nativeDecks,
              performanceChannelGainsRef.current,
              visualActiveIndexRef.current,
            );
        // DJ 曲库双击负责上轨：空闲/暂停 Deck 优先；两侧都走带时替换实际
        // 通道输出更低的一侧，完全相同才替换非焦点侧。不能再用“视觉另一侧”猜。
        // 是否立刻起播由「加载后立即播放」决定。
        void loadPerformanceTrackRef.current(side, next, useDjConfig.getState().playOnLoad).catch((error: unknown) => {
          setNotice(`装入 Deck ${side === 0 ? "A" : "B"} 失败：${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      }
      // DJ 亮着且正在放别的歌：**所有**播放入口（双击、右键播放、自动续播
      // 挑的下一首）都从当前位置接歌，不硬切。网络视频预览不走 PLAY_EVENT；
      // 曲库里的本地视频则和音频一样由 Rust Deck 发声，必须允许进入这条过渡。
      if (wantsDjTransition && current) {
        if (isLocalVideo) {
          // playTrack 已同步建立视频 session。先在同一事件循环把它改为“装画面但
          // 暂不走带”，否则 Rust 还在准备淡入 Deck 时，静音视频会先从 0 独自跑。
          // handoff 落地后 track/play 广播会从同一 cue 启动画面。
          requestLocalVideo(next, false);
        }
        if (djSwitchTo(next, current)) return;
        if (isLocalVideo) {
          // 引擎没有接手（例如当前原生平台不支持实时 DJ）：恢复普通硬切的自动播放。
          requestLocalVideo(next, true);
        }
      }
      // 详情视频控件再点播放：同一首只需恢复播放，绝不能把进度打回 0。
      if (current && next.id === current.id) {
        if (usesLocalLibraryRecord(next)) selectTrack(next);
        commitPlaying(autoPlay);
        if (autoPlay) markPlayed(next.id);
        return;
      }
      if (isStreamTrack(next) && !nativePlayer) {
        setBrowserDjSession(true);
      }
      // 每次装入不同曲目都换到另一侧固定 Deck。以前只有自动过渡结束才更新侧别，
      // 普通双击/暂停时换曲会永远覆盖 Deck A，导致第二轨的播放键和旋转状态失真。
      const incomingIndex = nextLoadedDeckIndex(
        visualActiveIndexRef.current,
        current?.id ?? null,
        next.id,
      );
      visualActiveIndexRef.current = incomingIndex;
      setVisualActiveIndex(incomingIndex);
      // Native local playback must enter the command lane before React commits the selected row,
      // TrackDetail and the manager Control canvases. Unsupported sources keep the effect path.
      eagerManagerLoadRef.current(next, autoPlay);
      // The first authoritative snapshot for a new song must update detail immediately; only
      // steady-state position traffic is allowed to use the 200ms broadcast throttle.
      lastBroadcast.current = Number.NEGATIVE_INFINITY;
      // 同一用户手势里的后续 transport/seek 读 ref；不能等下一轮 effect 才同步，
      // 否则启动恢复请求恰好在这两帧间返回时会把旧唱盘抢回来。
      trackRef.current = next;
      setTrack(next);
      // 右侧详情跟着切到正在放的这首。自动续播接下一首时尤其重要——
      // 不跟的话详情栏还停在上一首，用户看着 A 的 BPM 听着 B
      if (usesLocalLibraryRecord(next)) selectTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      commitPlaying(autoPlay && !isUnresolvedStreamTrack(next));
      // 手动点播的也记进"放过了"：不然自动续播会把用户刚听完的那首再接一遍
      if (autoPlay) markPlayed(next.id);
    };
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, [
    selectTrack,
    focusLibrary,
    djSwitchTo,
    commitPlaying,
    invalidateNativeSeek,
    nativePlayer,
    dualDeck,
  ]);

  // 本地视频会话只能属于正在走带的那首。自动续播 / DJ 过渡直接在 PlayerBar
  // 内部 setTrack，不一定经过 playTrack（后者原本才会清视频会话）；因此旧视频会在
  // 音频换手后继续静音播放。DJ 过渡期间旧歌还在退场，等 phase 回 idle 再关画面；
  // 普通硬切则立即拆掉旧视频和系统 PiP。
  useEffect(() => {
    const pip = useVideoPip.getState();
    if (pip.session?.source !== "local") return;
    if (track?.id === pip.session.trackId) return;
    if (djTransition.phase !== "idle") return;
    pip.clear();
  }, [track?.id, djTransition.phase]);

  // 起手点：有结束点 → 从结束点倒推 N 小节；否则只读取已经存在的 overview 来找
  // 真实尾音，再按时长倒推。播放临界路径绝不为这个优化启动整轨解码；冷缓存的
  // overview 由独立预取在音频空闲时补齐，当前接歌始终有同步的时长兜底。
  useEffect(() => {
    djOutroRef.current = { trackId: track?.id ?? -1, at: null };
    if (!track || !djEnabled || dualDeck) return;
    const lead = mixSeconds(track.bpm, djBars);
    if (applyInOutPoints && track.end_ms != null) {
      const endSec = track.end_ms / 1000;
      djOutroRef.current = {
        trackId: track.id,
        at: Math.max(0, endSec - lead),
      };
      return;
    }
    if (isStreamTrack(track)) {
      djOutroRef.current = {
        trackId: track.id,
        at: mixStartFromDuration(track.duration ?? 0, track.bpm, djBars),
      };
      return;
    }
    const waveform = cachedReleaseOverviewWaveform(track.id);
    const at = waveform
      ? findMixStartTime(waveform, lead)
        ?? mixStartFromDuration(waveform.duration, track.bpm, djBars)
      : mixStartFromDuration(track.duration ?? 0, track.bpm, djBars);
    djOutroRef.current = {
      trackId: track.id,
      at,
    };
  }, [track?.id, track?.duration, track?.end_ms, track?.bpm, djEnabled, djBars, applyInOutPoints, dualDeck]);

  // 放到一首还没分析的歌 → 让它插队分析。去重、和"选中即分析"共享一份
  // 排队记号的逻辑都在 autoAnalyze 里，这里只负责把"在放哪一首"告诉它。
  useEffect(() => {
    if (usesLocalLibraryRecord(track)) analyzePlaying(track);
  }, [track?.id, track?.analyzed_at]);

  // 换曲：移动端交给系统媒体服务，正式桌面交给 Rust/CPAL，纯浏览器调试才走
  // Web Audio preview adapter。选择集中在这里，其他播放入口不感知声卡后端。
  useEffect(() => {
    if (!track) return;
    const eagerLoad = eagerManagerLoadTokenRef.current;
    if (
      eagerLoad?.trackId === track.id &&
      eagerLoad.generation === nativeLoadGenerationRef.current
    ) {
      eagerManagerLoadTokenRef.current = null;
      return;
    }
    if (eagerLoad) eagerManagerLoadTokenRef.current = null;
    resetPerformanceControlsForManagerLoad();
    // DJ prepare/handoff 已把曲目装进第二台 Rust/Web Audio Deck；不能让换曲 effect
    // 再执行一次普通 load，把正在进行的 sample-clock 过渡重置掉。
    if (djViaRef.current === track.id) {
      djViaRef.current = null;
      setNotice("");
      return;
    }
    const applyAutomaticCue = autoInOutCueRef.current === track.id;
    const restoredPosition =
      restoredPositionRef.current?.trackId === track.id
        ? restoredPositionRef.current.position
        : null;
    if (restoredPositionRef.current?.trackId === track.id) restoredPositionRef.current = null;
    const retainRestoredPositionAfterFailure = () => {
      if (restoredPosition !== null && trackRef.current?.id === track.id) {
        restoredPositionRef.current = { trackId: track.id, position: restoredPosition };
      }
    };
    const initialPosition = restoredPosition ??
      (applyAutomaticCue && track.cue_ms != null ? Math.max(0, track.cue_ms / 1000) : 0);
    autoInOutCueRef.current = null;
    const loadGeneration = ++nativeLoadGenerationRef.current;
    nativeLoadInFlightRef.current = true;
    nativeLoadTargetRef.current = { trackId: track.id, generation: loadGeneration };
    const player = nativePlayer;
    const stillCurrent = () => loadGeneration === nativeLoadGenerationRef.current;
    const autoplayAfterResolve = deferredStreamAutoplayRef.current === track.id;
    const stopAfterFailedLoad = () => {
      // Native handoff keeps the old Deck audible until the replacement is ready. If the new
      // online source fails, explicitly stop that retained Deck; updating React state alone
      // would show the online title while a stale local song kept sounding underneath.
      commitPlaying(false);
      if (player) void player.pause().catch(() => {});
      else djEngine.hardPause(djEngine.frontElement());
    };
    void (async () => {
      try {
        const wasUnresolved = isUnresolvedStreamTrack(track);
        if (wasUnresolved) {
          // 唱盘已经换到这首；解析直链期间先停掉上一首，避免封面已经是新歌、喇叭还在放旧歌。
          if (player) {
            // PLAY_EVENT already submitted a physical Clear on the control lane. Await its ACK so
            // this new Load cannot race ahead and leave the previous Deck available for rollback.
            await sourceReplacementFenceRef.current;
          }
          else {
            djEngine.releaseDecodedPlayback();
            djEngine.cancel();
            djEngine.hardPause(djEngine.frontElement());
          }
        }
        // 本地文件与平台流只在 playbackTrack adapter 内解析来源；
        // 从这里开始全部使用同一个 UnifiedPlayerSource 契约。
        const prepared = await playbackSourceForTrack(track, {
          position: initialPosition,
          autoplay: autoplayAfterResolve || playingRef.current,
        });
        if (!stillCurrent()) return;
        if (wasUnresolved) setBrowserMediaStatus("loading");
        const source = prepared.src;
        if (player) {
          if (desktopNative) {
            djEngine.cancel();
            djEngine.hardPause(djEngine.frontElement());
          }
          // Desktop Load carries the latest master gain atomically. Mobile keeps its existing
          // explicit volume command because it owns a different native media contract.
          if (!desktopNative) void player.setVolume(playerVolumeRef.current).catch(() => {});
          void player
            .load(prepared)
            .then((state) => {
              if (!stillCurrent()) return;
              if (state.status === "error") {
                if (deferredStreamAutoplayRef.current === track.id) {
                  deferredStreamAutoplayRef.current = null;
                }
                retainRestoredPositionAfterFailure();
                stopAfterFailedLoad();
                nativeLoadTargetRef.current = null;
                nativeLoadInFlightRef.current = false;
                setNotice(state.error || "原生播放器无法播放这个文件");
                return;
              }
              setPosition(state.currentTime);
              setDuration(state.duration || track.duration || 0);
              // ACK 时目标通常仍在 Loading。此处若 commitPlaying(true)，transport effect
              // 会向仍装着上一首的物理 front Deck 发 Play，正是“双击后立即播放旧歌”。
              // 真正激活由原生 snapshot 的 target-id + !buffering 边沿提交。
              setNotice("");
            })
            .catch((error: unknown) => {
              if (!stillCurrent()) return;
              if (deferredStreamAutoplayRef.current === track.id) {
                deferredStreamAutoplayRef.current = null;
              }
              nativeLoadTargetRef.current = null;
              nativeLoadInFlightRef.current = false;
              retainRestoredPositionAfterFailure();
              stopAfterFailedLoad();
              setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
            })
          return;
        }
        nativeLoadInFlightRef.current = false;
        nativeLoadTargetRef.current = null;
        if (desktopNative) void playerRuntime.pause();
        // 硬切歌（双击列表、回上一首）顺手掐掉可能还在进行的过渡：
        // 不掐的话暗处退场那台 deck 还会再响好几秒
        djEngine.releaseDecodedPlayback();
        djEngine.cancel();
        // cancel 可能刚把尚在准备的 shadow deck 定为目标正主，不能继续使用旧闭包里的元素。
        const audio = djEngine.frontElement();
        setFrontEl(audio);
        // 在线渐进波形从共享 AnalyserNode 取样；先接好音频图，但不预取 shadow、
        // 不整轨解码。此时媒体尚未起播，不会在重接输出时产生爆音。
        if (isStreamTrack(track)) djEngine.warmup();
        audio.src = source;
        audio.load();
        if (initialPosition > 0) {
          const applyCue = () => {
            try {
              audio.currentTime = initialPosition;
            } catch {
              /* metadata 未到时忽略，seeked/canplay 还会再试 */
            }
            setPosition(initialPosition);
          };
          if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) applyCue();
          else audio.addEventListener("loadedmetadata", applyCue, { once: true });
        }
        // shadow 只作解码尚未完成时的回退；正常路径后台准备当前曲目的受限 PCM。
        // 在线流由媒体元素自己的分段缓存负责。若在这里再准备 shadow + 整轨 PCM，
        // 一次试听会出现两到三份并行请求；本地文件才需要无缝 seek 的整轨解码。
        if (!isStreamTrack(track)) {
          djEngine.prepareSeek(source);
          djEngine.prepareDecodedSeek(track, source);
        }
        setNotice("");
        if (autoplayAfterResolve) {
          deferredStreamAutoplayRef.current = null;
          commitPlaying(true);
        }
      } catch (error: unknown) {
        if (!stillCurrent()) return;
        retainRestoredPositionAfterFailure();
        stopAfterFailedLoad();
        if (deferredStreamAutoplayRef.current === track.id) {
          deferredStreamAutoplayRef.current = null;
        }
        nativeLoadTargetRef.current = null;
        setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        nativeLoadInFlightRef.current = false;
      }
    })();
    // 播放只交给下面监听 playing/track 的 effect。这里再 play 一次会在暂停后
    // 双击换曲时形成 load → play → play 竞态，其中一个 AbortError 又把状态停掉。
    // playing 不进依赖：它变化时由下面的 effect 处理，这里只管换曲。
    // frontEl 也不进：它只在 DJ 接歌互换时变，而那条路在上面已经 return 了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, sourceLoadEpoch, nativePlayer, desktopNative, playerRuntime, commitPlaying]);

  // 把用户明确排好的下一首预装进系统播放器。更新队尾只修改 Media3 timeline
  // 的非当前项，不重建正在发声的 MediaSource，因此不会因排队操作产生卡顿。
  useEffect(
    () => () => {
      if (nativeQueueRetryTimerRef.current !== null) {
        window.clearTimeout(nativeQueueRetryTimerRef.current);
        nativeQueueRetryTimerRef.current = null;
      }
      nativeQueueSignatureRef.current = "";
      nativeQueuePendingSignatureRef.current = "";
      nativeQueueDesiredSignatureRef.current = "";
    },
    [nativePlayer],
  );

  useEffect(() => {
    if (dualDeck) {
      nativeQueueSignatureRef.current = "";
      nativeQueuePendingSignatureRef.current = "";
      nativeQueueDesiredSignatureRef.current = "";
      if (nativePlayer) void nativePlayer.setQueue([]).catch(() => {});
      return;
    }
    if (!nativePlayer || !track) {
      nativeQueueSignatureRef.current = "";
      nativeQueuePendingSignatureRef.current = "";
      nativeQueueDesiredSignatureRef.current = "";
      return;
    }
    const tracks = [track].filter((item) => !isStreamTrack(item));
    if (tracks.length === 0) {
      nativeQueueSignatureRef.current = "";
      nativeQueuePendingSignatureRef.current = "";
      nativeQueueDesiredSignatureRef.current = "";
      return;
    }
    const signature = tracks
      .map((item) => `${item.id}:${item.path}:${item.modified_at}`)
      .join("|");
    if (nativeQueueDesiredSignatureRef.current !== signature) {
      nativeQueueDesiredSignatureRef.current = signature;
      nativeQueueRetrySignatureRef.current = signature;
      nativeQueueRetryCountRef.current = 0;
    }
    // 若旧队列更新 B 还在 commandTail 中，而当前期望又回到已确认的 A，
    // 仍要提交一次 A 来推进 revision，让 B 在进入 IPC 前失效。
    if (
      signature === nativeQueuePendingSignatureRef.current ||
      (signature === nativeQueueSignatureRef.current &&
        nativeQueuePendingSignatureRef.current === "")
    ) {
      return;
    }
    const sources = tracks.map((item) => ({
      src: mediaUrlForTrack(item),
      track: item,
      artworkUrl: playbackCoverUrl(item),
    }));
    nativeQueuePendingSignatureRef.current = signature;
    void nativePlayer
      .setQueue(sources)
      .then(() => {
        if (nativeQueuePendingSignatureRef.current !== signature) return;
        nativeQueuePendingSignatureRef.current = "";
        if (nativeQueueDesiredSignatureRef.current === signature) {
          nativeQueueSignatureRef.current = signature;
          nativeQueueRetryCountRef.current = 0;
        }
      })
      .catch((error: unknown) => {
        if (nativeQueuePendingSignatureRef.current !== signature) return;
        nativeQueuePendingSignatureRef.current = "";
        if (nativeQueueDesiredSignatureRef.current !== signature) return;
        setNotice(`后台队列同步失败：${error instanceof Error ? error.message : String(error)}`);
        if (nativeQueueRetrySignatureRef.current !== signature) {
          nativeQueueRetrySignatureRef.current = signature;
          nativeQueueRetryCountRef.current = 0;
        }
        if (nativeQueueRetryCountRef.current >= 3 || nativeQueueRetryTimerRef.current !== null) {
          return;
        }
        nativeQueueRetryCountRef.current += 1;
        nativeQueueRetryTimerRef.current = window.setTimeout(() => {
          nativeQueueRetryTimerRef.current = null;
          if (
            nativeQueueDesiredSignatureRef.current === signature &&
            nativeQueueSignatureRef.current !== signature
          ) {
            setNativeQueueRetry((value) => value + 1);
          }
        }, 250);
      });
  }, [nativePlayer, track?.id, nativeQueueRetry, dualDeck]);

  const driveGlobalTransport = true;
  const droveGlobalTransportRef = useRef(driveGlobalTransport);
  useEffect(() => {
    if (!track) return;
    const becameEnabled = driveGlobalTransport && !droveGlobalTransportRef.current;
    droveGlobalTransportRef.current = driveGlobalTransport;
    if (!driveGlobalTransport) {
      // Performance buttons already emitted an explicit A/B command. Replaying the manager's
      // global transport here would target the coordinator's previous `front` Deck and start
      // the opposite side whenever focus/track display changes.
      transportHandledRef.current = false;
      return;
    }
    if (becameEnabled) {
      // Returning to the manager is presentation-only. Do not infer a Play/Pause command from
      // the aggregate React flag: the focused Deck may be paused while the other side is audible.
      transportHandledRef.current = false;
      return;
    }
    if (nativePlayer) {
      if (transportHandledRef.current) {
        transportHandledRef.current = false;
        return;
      }
      const operation = playing ? nativePlayer.play() : nativePlayer.pause();
      void operation.catch((error: unknown) => {
        commitPlaying(false);
        setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (transportHandledRef.current) {
      transportHandledRef.current = false;
      return;
    }
    if (playing) {
      // 除了首播，也接住系统休眠、切换音频设备后 context 再次被挂起的情况。
      djEngine.resume();
      if (!useCrossfade.getState().coplay) djEngine.setVolume(playerVolumeRef.current);
      setNotice("");
      // DJ begin 已经在按「seek cue → 缓冲 → 设 BPM → 起播」准备新 deck。
      // 这里若因为 frontEl/track 切换再 play 一次，新歌会先按默认位置暗中运行，
      // 随后被 seek 和变速，正是进场临界点偶发短暂停顿的来源。
      if (!djEngine.isTransitioning()) {
        // 基础 transport 只做原曲增益包络，不叠加合成电机声；后者起音太短，
        // 容易被听成媒体解码卡顿或爆音。DJ 接歌效果仍保留自己的音效。
        // softPlay 会从当前增益反向接管尚未完成的淡出；预先 ensureAudible 会把
        // 增益硬拉回 1，正是快速恢复时偶发一下突跳/不淡入的来源。
        if (!transportFade) djEngine.ensureAudible();
        const operation = transportFade ? djEngine.softPlay(frontEl) : djEngine.hardPlay(frontEl);
        void operation.catch((error: unknown) => {
          commitPlaying(false);
          setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } else {
      // 停下要连暗处那台一起按住。cancel/seekAbort 可能同步互换正主，不能再用
      // effect 闭包里的旧 frontEl，否则会把暗台暂停两次、真正正主却继续响。
      const currentFront = djEngine.frontElement();
      if (currentFront !== frontElRef.current) setFrontEl(currentFront);
      if (transportFade) {
        void djEngine.softPause().catch((error: unknown) =>
          setNotice(`暂停当前播放失败：${error instanceof Error ? error.message : String(error)}`),
        );
      } else {
        djEngine.cancel();
        djEngine.hardPause(currentFront);
      }
    }
  }, [
    playing,
    track,
    frontEl,
    nativePlayer,
    commitPlaying,
    transportFade,
    driveGlobalTransport,
  ]);

  // 视频可以从自己的控件发出播放/暂停/跳转；协同预览没有 trackId，
  // 本地视频则必须只接收当前曲目的消息，避免详情切换后误控旧视频。
  useEffect(() => {
    const onMediaSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner === "player") return;
      if (detail.owner === "preview" && !useCrossfade.getState().coplay) return;
      if (detail.owner === "local-video" && detail.trackId !== track?.id) return;
      if (!track) return;
      // 视频侧一律硬切：软启停会让音频还在淡、视频已 play/pause，再叠加纠偏就卡。
      if (detail.action === "play") {
        commitPlaying(true);
      } else if (detail.action === "pause") {
        commitPlaying(false);
      } else if (detail.action === "seek" && detail.position !== undefined) {
        const at = Math.max(0, detail.position);
        // Native video controls must enter the same transaction as the main waveform. This pins
        // the visible playhead while Rust lands, keeps the latest-value seek lane, and coordinates
        // the dual-video presenter instead of maintaining a weaker second seek implementation.
        window.dispatchEvent(
          new CustomEvent<SeekDetail>(SEEK_EVENT, {
            detail: {
              trackId: track.id,
              position: at,
              scrubbing: false,
              forceCommit: true,
            },
          }),
        );
      }
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onMediaSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onMediaSync);
  }, [track?.id, commitPlaying]);

  // 播放器是同步时钟：视频只在明显漂移时纠偏，避免每个 timeupdate 都 seek
  // 造成画面抖动。播放/暂停/跳转动作仍然双向广播。
  useEffect(() => {
    if (!track) return;
    const position = nativePlayer?.state().currentTime ?? djEngine.currentTime(frontEl);
    const rate = nativePlayer?.state().rate ?? frontEl.playbackRate;
    broadcastMediaSync({
      owner: "player",
      action: playing ? "play" : "pause",
      trackId: track.id,
      // 视频恢复播放时必须从当前唱盘位置继续。省略 position 会被当成 0，
      // 暂停后再播放就会把视频错误拉回 Offset 起点。
      position,
      rate,
    });
    if (isStreamTrack(track)) {
      publishStreamTrackState(
        track,
        position,
        playing,
        rate,
      );
    }
  }, [playing, track?.id, frontEl, nativePlayer]);

  // 底栏推子是持久化 MASTER 音量；协同播放时再与等功率交叉推子相乘。
  useEffect(() => {
    playerVolumeRef.current = playerVolume;
    // 用户音量与协同交叉推子相乘；移动端直接落到系统 player，桌面两台 deck
    // 一起设，接歌中途也保持一致。
    const effective = playerVolume * deckGain(coplay, fadeX);
    if (nativePlayer) void nativePlayer.setVolume(effective);
    else djEngine.setVolume(effective);
  }, [playerVolume, coplay, fadeX, nativePlayer]);

  useEffect(() => {
    let frame = 0;
    let currentShown = 0;
    let clipHoldUntil = 0;
    let previousAt = performance.now();
    const history: Array<{ at: number; level: number }> = [];
    const paint = (at: number) => {
      const dt = Math.min(0.1, Math.max(0, (at - previousAt) / 1_000));
      previousAt = at;
      const state = playerRuntime.state();
      let peak = 0;
      ([0, 1] as const).forEach((side) => {
        const deck = state.decks[side];
        if (!deck.playing && !deck.desiredPlaying) return;
        peak = Math.max(peak, getLiveDeckPeak(side) ?? deck.peakLevel ?? 0);
      });
      const volume = playerVolumeRef.current;
      const target = playerVolumeMeterLevel(peak, volume);
      if (playerVolumeMeterClipping(peak, volume)) clipHoldUntil = at + 1_000;
      currentShown = smoothPlayerVolumeMeter(currentShown, target, dt);
      history.push({ at, level: currentShown });
      const delayedAt = at - playerVolumeMeterLagMs(track?.bpm);
      while (history.length > 1 && history[1].at <= delayedAt) history.shift();
      const previousSlice = history[0]?.level ?? 0;
      const meter = playerVolumeMeterRef.current;
      meter?.style.setProperty("--kd-volume-current", `${currentShown * 100}%`);
      meter?.style.setProperty("--kd-volume-previous", `${previousSlice * 100}%`);
      meter?.toggleAttribute("data-clipping", at < clipHoldUntil);
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [playerRuntime, track?.bpm]);

  // 拨开协同播放（epoch +1）= 「两边同时从头来」：唱盘倒回 0 起播，
  // 预览那侧按 Offset 自己对位。不从头对齐的话，两条时间线的相对位置
  // 全看拨开关那一刻的手气，校出来的 Offset 毫无意义。
  // 协同关掉时不动唱盘——关推子的人多半正听着唱盘这一侧。
  const fadeEpoch = useCrossfade((state) => state.epoch);
  useEffect(() => {
    // epoch 会跨视频预览生命周期保留。PlayerBar 因 HMR/布局变化重挂载时，
    // 旧 epoch 不能在 coplay 已关闭的情况下把歌曲擅自归零并重播。
    if (!coplay || fadeEpoch === 0) return; // 0 = 还没开过协同
    // 只“选中”但还没装进 deck 是最常见的协同入口。旧代码在 !track 时直接
    // return，结果视频从头响了、底部歌曲仍是 0:00/0:00。先走正常播放入口，
    // PLAY_EVENT 会把 selected 装入 deck 并从头启动。
    if (!track) {
      if (selected) playTrack(selected);
      return;
    }
    if (nativePlayer) {
      requestNativeSeek(track.id, 0);
    } else {
      void djEngine
        .seamlessSeek(mediaUrlForTrack(track), 0, playingRef.current)
        .then(setFrontEl);
    }
    setPosition(0);
    broadcastMediaSync({ owner: "player", action: "seek", trackId: track.id, position: 0 });
    commitPlaying(true);
    // track 不进依赖：只在拨开关那一下重启，换歌不该再从头来一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeEpoch, coplay]);

  // 播放中不能再让正在出声的 element 自己 seek：WebKit 换 Range/解码期间必然断流。
  // 交给 shadow deck 在目标处静音备好，旧声持续到音频时钟完成无缝换手。
  useEffect(() => {
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<SeekDetail>).detail;
      // scrub 边界先落标记、再查 id：拖动中换曲后，cancel/卸载清理可能带着
      // 上一首的 id 到达，若被下面的守卫提前 return，时钟压制就永远松不开。
      if (detail.scrubbing !== undefined) scrubbingRef.current = detail.scrubbing;
      if (!track || detail.trackId !== track.id || !Number.isFinite(detail.position)) return;
      const target = Math.max(0, detail.position);
      // 拖动时只更新视觉位置（期间权威时钟被 scrub 标记压制，不会顶回播放头）；
      // 松手再启动一次真正的媒体跳转。否则每个 pointermove
      // 都会重建 shadow deck / 发 Range 请求，越拖积压越多，看起来像整条波形黏住。
      if (detail.preview) {
        setPosition(target);
        if (isVideoTrack(track.format)) {
          if (detail.scrubbing === false) {
            cancelLocalVideoSeekPreview(track.id);
          } else {
            previewLocalVideoSeek(track.id, target);
            const pip = useVideoPip.getState();
            if (pip.session?.source === "local" && pip.session.trackId === track.id) {
              pip.setPosition(target);
            }
          }
        }
        return;
      }
      // 第一次 input 会在指针仍按着时立刻正式跳转，并携带 scrubbing=true；
      // 这时继续压住权威时钟。只有松手/键盘跳转才恢复跟随。
      if (detail.scrubbing !== true) scrubbingRef.current = false;
      setPosition(target);
      if (isStreamTrack(track)) {
        publishStreamTrackState(
          track,
          target,
          playingRef.current,
          frontElRef.current.playbackRate,
        );
      }
      if (!shouldCommitSeek(track.id, target, detail.forceCommit)) return;
      const generation = ++seekGenerationRef.current;
      const publishVideoSeek = () => {
        if (generation !== seekGenerationRef.current) return;
        broadcastMediaSync({
          owner: "player",
          action: "seek",
          trackId: track.id,
          position: target,
        });
      };
      const commitAudioTransport = (): Promise<void> | void => {
        if (generation !== seekGenerationRef.current) return;
        if (nativePlayer) {
          // 后端会把换曲/接歌装载期的跳转折进待激活流；先按住用户点下的位置，
          // 等状态事件落到目标附近再交回跟随。请求槽只保留最后一个目标，避免
          // Android 快速点波形时把旧 seek 一层层排进原生命令队列。
          requestNativeSeek(track.id, target);
          // Give the Tauri/Rust command lane one short uncontended head start. Waiting for the
          // playback-state landing here pinned the progress/video for seconds on large MP4s;
          // 120ms is enough for IPC dispatch while keeping the visual catch-up prompt.
          return new Promise<void>((resolve) => window.setTimeout(resolve, 120));
        } else {
          return djEngine
            .seamlessSeek(mediaUrlForTrack(track), target, playingRef.current)
            .then((element) => {
              if (generation !== seekGenerationRef.current) return;
              setFrontEl(element);
            });
        }
      };
      const commitTransport = () => {
        publishVideoSeek();
        commitAudioTransport();
      };

      const dualVideo = isVideoTrack(track.format) && hasLocalVideoSeekPresenter(track.id);
      if (!dualVideo) {
        commitTransport();
        return;
      }

      holdLocalVideoSeekPosition(track.id);
      const pip = useVideoPip.getState();
      if (pip.session?.source === "local" && pip.session.trackId === track.id) {
        pip.setPosition(target);
      }
      // 音频 seek 是最高优先级：绝不能再等备用视频的 seeked/rVFC。目标画面若已在
      // 拖动预览中备好会紧跟着换手；否则旧画面继续运动，解码完成后再追上。
      // 画面准备期间仍压住受控 range，避免旧槽 timeupdate / 100ms 状态快照把
      // 用户选择的目标从进度条上顶回去。新手势会抬 generation 作废旧准备。
      scrubbingRef.current = true;
      void coordinateLocalVideoSeek(
        () => {
          const preparation = prepareLocalVideoSeek(track.id, target);
          if (!preparation) return Promise.resolve(null);
          return new Promise((resolve) => {
            let settled = false;
            const finish = (prepared: Awaited<typeof preparation>) => {
              if (settled) {
                prepared?.cancel();
                return;
              }
              settled = true;
              window.clearTimeout(timer);
              resolve(prepared);
            };
            const timer = window.setTimeout(() => {
              cancelLocalVideoSeekPreview(track.id);
              finish(null);
            }, 1_200);
            void preparation.then(finish, () => finish(null));
          });
        },
        {
          commitAudio: commitAudioTransport,
          publishVideoSeek,
          isCurrent: () => generation === seekGenerationRef.current,
        },
      ).then((result) => {
        if (result !== "stale" && generation === seekGenerationRef.current) {
          scrubbingRef.current = false;
        }
      });
    };
    window.addEventListener(SEEK_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [track, nativePlayer, requestNativeSeek, shouldCommitSeek]);

  // 和视频预览互斥出声（见 audioFocus.ts）：这边一开始放就喊一嗓子，
  // 预览听到会自己暂停；反过来预览开声时这边也自动停，只暂停不清进度。
  useEffect(() => {
    if (playing) announceAudioFocus("player");
  }, [playing]);
  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "player") return;
      // 协同播放中预览开声是意料之中的事，互斥对这一对失效
      if (owner === "preview" && useCrossfade.getState().coplay) return;
      if (!playingRef.current) return;
      invalidateNativeSeek();
      playbackIntentRef.current += 1;
      nativeDjGenerationRef.current += 1;
      nativeDjBusyRef.current = false;
      // 预览只会在 `playing`（已有媒体帧输出）后取得焦点。这里仍要同步发出真实
      // transport 暂停，不能只改 React 状态等下一帧，否则两路声音会短暂重叠。
      transportHandledRef.current = true;
      if (nativePlayer) {
        void nativePlayer.pause().catch((error: unknown) => {
          transportHandledRef.current = false;
          setNotice(`暂停当前播放失败：${error instanceof Error ? error.message : String(error)}`);
        });
      } else {
        const currentFront = djEngine.frontElement();
        if (currentFront !== frontElRef.current) setFrontEl(currentFront);
        if (transportFade) {
          void djEngine.softPause().catch((error: unknown) =>
            setNotice(`暂停当前播放失败：${error instanceof Error ? error.message : String(error)}`),
          );
        } else {
          djEngine.cancel();
          djEngine.hardPause(currentFront);
        }
      }
      commitPlaying(false);
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, [invalidateNativeSeek, nativePlayer, commitPlaying, transportFade]);

  const broadcast = useCallback(
    (seconds: number) => {
      if (!track) return;
      const now = performance.now();
      if (now - lastBroadcast.current < POSITION_BROADCAST_MS) return;
      lastBroadcast.current = now;
      window.dispatchEvent(
        new CustomEvent<PositionDetail>(POSITION_EVENT, {
          detail: { trackId: track.id, position: seconds },
        }),
      );
    },
    [track],
  );

  const continueAfterEnded = useCallback(
    (finished: Track | null) => {
      if (dualDeck) {
        // Performance 的 Deck 生命周期由各自 transport 管理。曲末只停这台 Deck，
        // 不能进入共享 pickNext，也不能因一侧结束把仍在播放的另一侧全局停掉。
        const otherStillPlaying = finished
          ? playerRuntime.state().decks.some(
              (deck) => deck.trackId !== finished.id && (deck.playing || deck.desiredPlaying),
            )
          : false;
        commitPlaying(otherStillPlaying);
        return;
      }
      if (!autoAdvanceRef.current) {
        commitPlaying(false);
        return;
      }
      // 正在挑歌 / 原生 prepare·handoff / UI 已切到接歌目标：别硬切把过渡顶掉。
      // djBusy 在 djSwitchTo 同步返回后就会清掉，必须同时看 nativeDjBusy。
      if (
        endedAdvanceRef.current ||
        djBusyRef.current ||
        nativeDjBusyRef.current ||
        hybridDjBusyRef.current ||
        djViaRef.current !== null
      ) {
        return;
      }
      if (!finished) {
        commitPlaying(false);
        return;
      }
      // 旧 deck 的迟到 ended 事件不能替用户刚点的新曲目挑歌。
      const intent = playbackIntentRef.current;
      if (trackRef.current?.id !== finished.id) return;
      const request = { trackId: finished.id, intent };
      endedAdvanceRef.current = request;
      const stillCurrent = () =>
        autoAdvanceRef.current &&
        endedAdvanceRef.current === request &&
        playbackIntentRef.current === intent &&
        trackRef.current?.id === finished.id;
      setPosition(0);
      // 在线试听也走共享的 pickNext：先兑现在线搜索的后继链，链耗尽后按
      // 播放模式回到本地曲库。
      const preferred = isStreamTrack(finished)
        ? streamNextTrack(finished)
        : predictedRef.current;
      const preferredGuard = isStreamTrack(finished)
        ? null
        : preferredPredictionGuard(finished);
      markPlayed(finished.id);
      void pickNext(finished, false, preferred, preferredGuard)
        .then((next) => {
          if (
            !stillCurrent() ||
            djBusyRef.current ||
            nativeDjBusyRef.current ||
            hybridDjBusyRef.current ||
            djViaRef.current !== null
          ) {
            return;
          }
          if (!next) {
            commitPlaying(false);
            return;
          }
          if (next.id === finished.id) {
            const cueSec =
              useDjConfig.getState().applyInOutPoints && finished.cue_ms != null
                ? finished.cue_ms / 1000
                : 0;
            commitPlaying(true);
            if (nativePlayer) {
              void nativePlayer.seek(cueSec).then(() => {
                if (stillCurrent()) return nativePlayer.play();
                return undefined;
              });
            } else {
              const audio = djEngine.frontElement();
              audio.currentTime = cueSec;
              if (stillCurrent()) void audio.play();
            }
            setPosition(cueSec);
            return;
          }
          // 接播开着时优先走双 Deck 过渡；只有引擎接不住才硬切。
          // 以前这里一律 playTrack，曲末稍晚触发就会「咔」一下跳过去。
          if (djEnabled && djSwitchTo(next, finished)) return;
          autoInOutCueRef.current =
            useDjConfig.getState().applyInOutPoints && !isStreamTrack(next) ? next.id : null;
          // 未解析在线曲也立刻 playTrack：唱盘反馈不能等直链；load effect 会 resolve。
          if (stillCurrent()) playTrack(next);
        })
        .catch(() => {
          if (stillCurrent()) commitPlaying(false);
        })
        .finally(() => {
          if (endedAdvanceRef.current === request) endedAdvanceRef.current = null;
        });
    },
    [nativePlayer, commitPlaying, djEnabled, djSwitchTo, dualDeck],
  );

  // 原生播放器即使 WebView 暂停也持续走时钟；回到前台后事件会带回权威状态。
  // 本地 ended 直接进入共享续播策略，不再伪造 HTMLAudioElement 事件。
  useEffect(() => {
    if (!nativePlayer) return;
    void nativePlayer.initialize().catch((error: unknown) => {
      setNotice(`原生播放器初始化失败：${error instanceof Error ? error.message : String(error)}`);
    });
    const unsubscribe = nativePlayer.subscribe((state, previous) => {
      setPerformanceDeckStates(state.decks);
      const pendingSwitch = pendingTrackSwitchRef.current;
      const pendingCurrent = trackRef.current;
      if (
        pendingSwitch &&
        pendingSwitch.intent === playbackIntentRef.current &&
        pendingCurrent?.id === pendingSwitch.trackId &&
        state.trackId !== pendingSwitch.trackId
      ) {
        // 这是上一首的权威快照，不是当前 UI 曲目的快照。保留物理 Deck 诊断，但绝不
        // 把旧时间、旧 ended/error 或旧 playing 写到新歌上，也不触发自动接下一首。
        setBrowserMediaStatus("resolving");
        return;
      }
      if (
        pendingSwitch &&
        (pendingSwitch.intent !== playbackIntentRef.current ||
          pendingCurrent?.id !== pendingSwitch.trackId)
      ) {
        pendingTrackSwitchRef.current = null;
      }
      const loadTarget = nativeLoadTargetRef.current;
      if (
        loadTarget &&
        loadTarget.generation === nativeLoadGenerationRef.current &&
        state.trackId === loadTarget.trackId &&
        !state.buffering &&
        state.status !== "loading"
      ) {
        nativeLoadTargetRef.current = null;
        nativeLoadInFlightRef.current = false;
        if (pendingTrackSwitchRef.current?.trackId === loadTarget.trackId) {
          pendingTrackSwitchRef.current = null;
        }
        if (
          state.status !== "error" &&
          deferredStreamAutoplayRef.current === loadTarget.trackId
        ) {
          deferredStreamAutoplayRef.current = null;
          // The target Deck is now physically installed and no longer buffering. This is the first
          // safe point to release the deferred autoplay intent; waiting for state.playing here is a
          // deadlock because Clear + Load intentionally left transport paused.
          commitPlaying(true);
        }
      }
      // 跳转回声抑制：seek 已提交但状态还没落到目标附近时，在飞的旧位置
      // 事件会把进度条弹回去再跳回来；落地、超时或换曲后恢复正常跟随。
      let pendingSeek = pendingSeekRef.current;
      if (pendingSeek) {
        const landed =
          state.trackId === pendingSeek.trackId &&
          Math.abs(state.currentTime - pendingSeek.position) < 1.5;
        if (
          landed ||
          state.trackId !== pendingSeek.trackId ||
          performance.now() - pendingSeek.at > 1500
        ) {
          pendingSeekRef.current = null;
          pendingSeek = null;
        }
      }
      const shownTime = pendingSeek ? pendingSeek.position : state.currentTime;
      positionRef.current = shownTime;
      durationRef.current = state.duration || durationRef.current;
      // scrub 拖动中不收时钟：否则每 100ms 一拍就把拖到一半的播放头顶回去。
      if (!scrubbingRef.current) {
        setPosition(shownTime);
      }
      if (state.duration > 0) setDuration(state.duration);

      if (desktopNative) {
        if (state.transitioning) {
          const incoming = transitionVisualRef.current?.incomingIndex ?? visualActiveIndexRef.current;
          setDjTransition({ phase: "mixing", frontIndex: incoming });
        } else if (previous.transitioning) {
          const visual = transitionVisualRef.current;
          if (visual) {
            visualActiveIndexRef.current = visual.incomingIndex;
            setVisualActiveIndex(visual.incomingIndex);
          }
          transitionVisualRef.current = null;
          setTransitionVisual(null);
          setDjTransition({ phase: "idle", frontIndex: visual?.incomingIndex ?? visualActiveIndexRef.current });
        }
      }

      const current = trackRef.current;
      if (current) {
        broadcast(shownTime);
        broadcastMediaSync({
          owner: "player",
          action: "position",
          trackId: current.id,
          position: shownTime,
          rate: state.rate,
        });
        if (isStreamTrack(current)) {
          const streamStatus: PlayerSessionStatus =
            isUnresolvedStreamTrack(current)
              ? "resolving"
              : nativeLoadInFlightRef.current
                ? "loading"
                : state.status === "error"
                  ? "error"
                  : state.status === "ended"
                    ? "ended"
                    : state.buffering || state.status === "loading"
                      ? "buffering"
                      : state.playing
                        ? "playing"
                        : "paused";
          setBrowserMediaStatus(streamStatus);
        }
        if (current.id < 0) {
          publishStreamTrackState(current, shownTime, state.playing, state.rate);
        }
        if (
          desktopNative &&
          !dualDeck &&
          state.playing &&
          !state.buffering &&
          djEnabled &&
          !state.transitioning &&
          !nativeDjBusyRef.current &&
          !djBusyRef.current &&
          djGaveUpRef.current !== current.id
        ) {
          const total = state.duration || current.duration || 0;
          const remain = total - state.currentTime;
          const mixLead = mixSeconds(current.bpm, djBars);
          const outro = djOutroRef.current;
          // outro.at 若比真实可播时长偏长（波形/元数据偏长），单靠 at 会永远不 due；
          // 用剩余时长再兜一层，避免拖到 ended 后硬切。
          const outroDue =
            outro.trackId === current.id &&
            outro.at !== null &&
            state.currentTime >= outro.at;
          const remainDue = remain > 0 && remain <= mixLead;
          const due = outroDue || remainDue;
          const allowShort = applyInOutPoints && current.end_ms != null;
          if ((total >= 30 || allowShort) && due) void nativeDjNextRef.current(false);
        }
      }

      // 拉回播放前先让暂停落地：pause 命令生效前的迟到 playing=true 帧不算数。
      // 窗口过后硬件若真还在放（暂停失败/外部起播），下一帧照常对账回来。
      if (
        state.playing &&
        !playingRef.current &&
        !nativeLoadInFlightRef.current &&
        performance.now() - pauseCommitAtRef.current > 1500
      ) {
        commitPlaying(true);
      }
      // 桌面端声音/画面对账：load 在飞、DJ 承诺未落地、过渡/缓冲都允许短暂分
      // 歧；其余稳定状态下 state.trackId 连续多拍 ≠ UI 曲目，说明硬件还停在旧
      // 歌上（例如接歌承诺被后台预热顶掉的竞态），以 UI 为准补一条原子 load
      // 自愈。移动端有自己的 adopt 逻辑，不走这里。
      if (
        desktopNative &&
        state.trackId !== null &&
        current &&
        state.trackId !== current.id &&
        !state.transitioning &&
        !state.buffering &&
        (state.status === "playing" || state.status === "paused") &&
        !nativeLoadInFlightRef.current &&
        !nativeDjBusyRef.current &&
        djViaRef.current === null
      ) {
        nativeTrackMismatchRef.current += 1;
        const heal = lastNativeHealRef.current;
        if (
          nativeTrackMismatchRef.current >= 3 &&
          (heal?.trackId !== current.id || performance.now() - heal.at > 5_000)
        ) {
          nativeTrackMismatchRef.current = 0;
          lastNativeHealRef.current = { trackId: current.id, at: performance.now() };
          const desynced = current;
          // 作废旧 load 的迟到回调；自愈直接发命令，不经过 React effect 链。
          nativeLoadGenerationRef.current += 1;
          void nativePlayer
            .load({
              src: mediaUrlForTrack(desynced),
              track: desynced,
              position: 0,
              autoplay: state.playing,
            })
            .catch(() => undefined);
        }
      } else {
        nativeTrackMismatchRef.current = 0;
      }
      if (
        state.status === "idle" &&
        previous.playing &&
        !nativeLoadInFlightRef.current &&
        playingRef.current
      ) {
        commitPlaying(false);
      }
      if (state.status === "ended" && previous.status !== "ended") {
        // 接播进行中：不要先把 playing 打成 false，否则可能和 handoff 收尾打架。
        // 无在途接歌时由 continueAfterEnded 决定硬切或补一次过渡。
        if (
          !djBusyRef.current &&
          !nativeDjBusyRef.current &&
          !hybridDjBusyRef.current &&
          djViaRef.current === null
        ) {
          if (!djEnabled) commitPlaying(false);
          continueAfterEnded(current);
        }
      }
      if (state.status === "error") {
        if (!nativeErrorEpisodeRef.current) nativeErrorRecoveryAvailableRef.current = true;
        nativeErrorEpisodeRef.current = true;
        const wantedStreamPlayback = Boolean(
          current &&
            isStreamTrack(current) &&
            (playingRef.current || deferredStreamAutoplayRef.current === current.id),
        );
        const retrySource =
          current && wantedStreamPlayback
            ? claimStreamCacheRetry(current)
            : null;
        commitPlaying(false);
        pendingTrackSwitchRef.current = null;
        nativeLoadTargetRef.current = null;
        nativeLoadInFlightRef.current = false;
        if (current && deferredStreamAutoplayRef.current === current.id) {
          deferredStreamAutoplayRef.current = null;
        }
        if (retrySource && current) {
          setBrowserMediaStatus("loading");
          setNotice("本地缓存或在线地址异常，正在重新连接…");
          void playSongPreview({
            source: retrySource,
            title: current.title,
            artist: current.artist,
            autoPlay: true,
            bypassCache: true,
          }).catch((reason: unknown) => {
            if (trackRef.current?.id === current.id) {
              setBrowserMediaStatus("error");
              setNotice(
                `在线试听重试失败：${reason instanceof Error ? reason.message : String(reason)}`,
              );
            }
          });
        } else {
          setNotice(state.error || "原生播放器无法播放这个文件");
        }
        manualNextTargetRef.current = null;
        nativeManualChainDepthRef.current = 0;
        manualNextGateRef.current?.cancel();
      } else {
        nativeErrorEpisodeRef.current = false;
      }
      // loading→transitioning 和 transition→stable 都可能让 latest next 获得一个
      // 安全 Deck 槽；每个权威状态边沿都尝试一次，gate 自己负责单飞。
      manualNextGateRef.current?.wake();
      // seek 也只在同一条权威状态边沿上尝试一次，避免在 Loading/Transitioning
      // 期间把最后一个目标继续排到原生 commandTail 后面。
      nativeSeekDrainRef.current();
    });
    const syncAfterResume = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) void nativePlayer.refresh();
    };
    document.addEventListener("visibilitychange", syncAfterResume);
    window.addEventListener("focus", syncAfterResume);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", syncAfterResume);
      window.removeEventListener("focus", syncAfterResume);
    };
  }, [
    nativePlayer,
    mobileNative,
    desktopNative,
    djEnabled,
    djBars,
    applyInOutPoints,
    broadcast,
    commitPlaying,
    selectTrack,
    continueAfterEnded,
    dualDeck,
  ]);

  /**
   * 「上一首」= 沿播放历史回退，不是"曲库里的前一行"。
   *
   * 用户是从推荐列表、搜索结果、各个文件夹里跳着放的，"曲库里的前一行"
   * 和他刚才听的那首多半没有关系。历史栈见 autoplay.ts。
   */
  const [canGoBack, setCanGoBack] = useState(false);
  // hasPrevious() 读的是模块级变量，React 不会因为它变了而重渲染，
  // 所以每次换歌之后主动同步一次按钮的禁用态
  useEffect(() => {
    setCanGoBack(hasPrevious());
  }, [track?.id]);

  const goPrevious = async () => {
    manualNextGateRef.current?.cancel();
    invalidateNativeSeek();
    manualNextTargetRef.current = null;
    nativeManualChainDepthRef.current = 0;
    const intent = ++playbackIntentRef.current;
    nativeDjGenerationRef.current += 1;
    nativeDjBusyRef.current = false;
    const id = stepBack();
    if (id === null) return;
    const previous = await trackById(id);
    if (playbackIntentRef.current !== intent) return;
    setCanGoBack(hasPrevious());
    // playTrack 会走 markPlayed，而回退**不该**改写历史——
    // 所以这里绕开它，直接换曲
    if (previous) {
      focusLibrary();
      if (dualDeck && nativePlayer?.supportsRealtimeDj) {
        const nativeDecks = nativePlayer.state().decks;
        const loadedSide = nativeDecks.findIndex((deck) => deck.trackId === previous.id);
        const side = loadedSide === 0 || loadedSide === 1
          ? loadedSide
          : performanceLoadDeckIndex(
              nativeDecks,
              performanceChannelGainsRef.current,
              visualActiveIndexRef.current,
            );
        await loadPerformanceTrackRef.current(side, previous, true, 0);
        return;
      }
      if (isStreamTrack(previous)) setBrowserDjSession(true);
      setTrack(previous);
      if (usesLocalLibraryRecord(previous)) selectTrack(previous); // 同上：详情栏跟着回退
      setPosition(0);
      setDuration(previous.duration ?? 0);
      commitPlaying(true);
    }
  };

  /**
   * DJ 接歌：挑下一首 → djSwitchTo 从当前位置开始过渡。
   * 返回 false 只表示当前不该走 DJ（暂停 / 预设关闭），调用方再走普通挑歌。
   * 一旦 pickNext 已经挑到并消费了队头，这里就负责到底：引擎接不住时硬切
   * 同一首，绝不能让调用方再 pickNext 一次把下一首也吞掉。
   */
  const djNext = useCallback(
    async (manual: boolean): Promise<boolean> => {
      const current = trackRef.current;
      if (!current || !playingRef.current || !djEnabled) return false;
      // 自动 timeupdate 的重复触发要被吞掉；手动下一首也不能和在途挑歌
      // 叠两次，否则队列会连续消费两项。手动请求不能直接 noop：交还给 gate，
      // 等自动挑歌退出临界区后再兑现最后一次点击。
      if (djBusyRef.current) {
        if (manual) manualNextGateRef.current?.request();
        return true;
      }
      const intent = playbackIntentRef.current;
      const stillCurrent = () =>
        playbackIntentRef.current === intent && trackRef.current?.id === current.id;
      djBusyRef.current = true;
      try {
        markPlayed(current.id);
        const preferred = isStreamTrack(current) ? streamNextTrack(current) : predictedRef.current;
        const preferredGuard = isStreamTrack(current)
          ? null
          : preferredPredictionGuard(current);
        const next = await pickNext(current, manual, preferred, preferredGuard);
        if (!stillCurrent()) return true;
        if (!next || (manual && next.id === current.id)) {
          djGaveUpRef.current = current.id;
          return true;
        }
        // 单曲循环的自动续播：pickNext 会把当前曲目原样交回来。以前这里当成
        // 「挑不到候选」直接放弃，接歌开着时表现就是循环失效——曲子放完停在
        // Ended。现在原地接一场：同一首从 cue 重新进、过渡效果照常应用；
        // 同曲 prepare 会被 reusable_deck 幂等短路、handoff 找不到目标而失败，
        // 那条路会自动走硬切补偿（重新 load 同一首），循环依然成立。
        if (next.id === current.id) {
          if (djSwitchTo(next, current)) return true;
          playTrack(next);
          return true;
        }
        if (!djSwitchTo(next, current)) {
          if (useDjConfig.getState().applyInOutPoints && !isStreamTrack(next)) {
            autoInOutCueRef.current = next.id;
          }
          if (manual && manualNextDispatchingRef.current && nativePlayer) {
            manualNextTargetRef.current = next.id;
          }
          // 未解析在线曲也立刻装盘；直链由 load effect / install 路径等待。
          playTrack(next);
        }
        return true;
      } finally {
        djBusyRef.current = false;
        manualNextGateRef.current?.wake();
      }
    },
    [nativePlayer, djEnabled, djSwitchTo, commitPlaying],
  );
  nativeDjNextRef.current = djNext;

  /** 单次推进；重复点击的单飞/保留最新请求由下方 gate 管，不在这里做时间防抖。 */
  const advanceNextOnce = async () => {
    const current = currentAdvanceTrack();
    if (!current) return;
    const intent = ++playbackIntentRef.current;
    // DJ 预设亮着 → 从当前位置开始接歌。引擎不可用时 djNext 会硬切同一候选，
    // 不会再挑一次导致队列被连续消费。
    // 过渡中最多再承诺一场；更多连点由 gate 留到安全状态，不直接碰第三台候选。
    if (!dualDeck && djEnabled && (await djNext(true))) return;
    markPlayed(current.id);
    const preferred = isStreamTrack(current) ? streamNextTrack(current) : predictedRef.current;
    const preferredGuard = isStreamTrack(current)
      ? null
      : preferredPredictionGuard(current);
    const next = await pickNext(current, true, preferred, preferredGuard);
    if (
      playbackIntentRef.current !== intent ||
      (trackRef.current?.id ?? currentAdvanceTrackRef.current?.id) !== current.id
    ) {
      return;
    }
    // 候选池空了就安静停下，不报错——这是锦上添花的功能
    if (!next) return;
    if (useDjConfig.getState().applyInOutPoints && !isStreamTrack(next)) {
      autoInOutCueRef.current = next.id;
    }
    if (manualNextDispatchingRef.current && nativePlayer && djEnabled) {
      manualNextTargetRef.current = next.id;
    }
    // 在线下一首也立刻装盘；直链解析失败由 load effect 写 notice，不能挡唱盘反馈。
    playTrack(next);
  };

  canRunManualNextRef.current = () => {
    // 正式管理模式的“下一首”是一次普通换源，可以直接用最新播放意图覆盖尚未
    // 落地的预载/旧快照。此前仍套用双 Deck 的安全等待条件，播放器只要处于
    // loading、短暂 track-id 不一致或残留 transitioning，点击就会无限挂起，
    // 用户看到的结果就是按钮按了毫无反应。
    if (!dualDeck && !djEnabled) {
      manualNextTargetRef.current = null;
      nativeManualChainDepthRef.current = 0;
      return true;
    }
    if (djBusyRef.current || nativeDjBusyRef.current || hybridDjBusyRef.current) return false;
    if (!nativePlayer) {
      // Standalone browser adapter has no native target/command acknowledgement.
      manualNextTargetRef.current = null;
      // Web Audio 只有两台 Deck，也不能在一场过渡中重入 begin；idle 订阅会 wake。
      return !djEngine.isTransitioning();
    }

    const state = nativePlayer.state();
    const decision = decideNativeLatestIntent({
      // display/selected fallback 负责提供候选起点，却不能冒充已接管 transport 的 track。
      // 否则 Rust 残留的旧 trackId 会把首次“下一首”误判成永久失配。
      hasActiveTrack: trackRef.current !== null,
      currentTrackId: trackRef.current?.id ?? null,
      stateTrackId: state.trackId,
      targetTrackId: manualNextTargetRef.current,
      buffering: state.buffering,
      transitioning: state.transitioning,
      chainDepth: nativeManualChainDepthRef.current,
      // Android 与桌面共用双 Deck coordinator；iOS 系统播放器没有 deferred 槽。
      allowsDeferredTransition: desktopNative,
      errored: state.status === "error",
      errorRecoveryAvailable: nativeErrorRecoveryAvailableRef.current,
    });
    if (decision.targetSettled) {
      // ACK 只说明命令已登记；这里的权威状态边沿才说明目标真正装盘。
      manualNextTargetRef.current = null;
    }
    nativeManualChainDepthRef.current = decision.chainDepth;
    if (decision.consumeErrorRecovery) nativeErrorRecoveryAvailableRef.current = false;
    return decision.canRun;
  };
  runManualNextRef.current = async () => {
    manualNextDispatchingRef.current = true;
    try {
      await advanceNextOnce();
    } finally {
      manualNextDispatchingRef.current = false;
    }
  };
  const goNext = async () => {
    manualNextGateRef.current?.request();
  };
  remoteNextRef.current = goNext;
  remotePreviousRef.current = goPrevious;

  useEffect(() => {
    if (!desktopNative) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<SystemMediaAction>("desktop-media-control", (event) => {
      systemMediaActionRef.current(event.payload);
    }).then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopNative]);

  /**
   * 底栏主按钮和空格键共用这一条。网络视频预览时控预览；否则控唱盘。
   * 必须在用户手势调用栈里直接 play/pause，WebKit 才认音频启动许可。
   */
  const toggleTransport = useCallback(() => {
    const pip = useVideoPip.getState();
    if (networkVideoOwnsTransport(pip.session, pip.active, pip.failed)) {
      toggleVideoPip();
      return;
    }
    const current = trackRef.current;
    // 解析/装载尚未落地时，播放键不是“暂停后可再播放”的状态。键盘快捷键和
    // 系统媒体键也必须与禁用中的前端按钮一致，不能重复启动同一条解析链。
    if (
      !playingRef.current &&
      current &&
      (nativeLoadInFlightRef.current ||
        (isUnresolvedStreamTrack(current) &&
          deferredStreamAutoplayRef.current === current.id))
    ) {
      return;
    }
    // 暂停/恢复也是用户意图：暂停期间完成的异步接播不能把声音擅自拉回来。
    manualNextGateRef.current?.cancel();
    manualNextTargetRef.current = null;
    nativeManualChainDepthRef.current = 0;
    playbackIntentRef.current += 1;
    nativeDjGenerationRef.current += 1;
    nativeDjBusyRef.current = false;
    if (!current) {
      // 重启后 track 尚未装载，但底栏已经恢复了上次正主唱盘；首按应直接
      // 播放眼前这首，而不是要求用户先回曲库重新选中一次。
      const pick = retainedDecks[visualActiveIndex] ?? selectedRef.current;
      if (pick) playTrack(pick);
      return;
    }
    if (!playingRef.current && isUnresolvedStreamTrack(current)) {
      // 启动时账号尚未绑定/网络未就绪会让后台预装失败。用户登录后第一次按播放
      // 必须重试同一首、同一进度，而不是对一张没有 source 的 Deck 直接发 Play。
      deferredStreamAutoplayRef.current = current.id;
      setBrowserMediaStatus("resolving");
      setNotice("");
      setSourceLoadEpoch((value) => value + 1);
      return;
    }
    if (!playingRef.current && !nativePlayer) djEngine.resume();
    const nextPlaying = !playingRef.current;
    transportHandledRef.current = true;
    if (nativePlayer) {
      const operation = nextPlaying ? nativePlayer.play() : nativePlayer.pause();
      void operation.catch((error: unknown) => {
        commitPlaying(false);
        setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (nextPlaying) {
      const currentFront = djEngine.frontElement();
      if (currentFront !== frontElRef.current) setFrontEl(currentFront);
      if (!transportFade) djEngine.ensureAudible();
      const operation = transportFade
        ? djEngine.softPlay(currentFront)
        : djEngine.hardPlay(currentFront);
      void operation.catch((error: unknown) => {
        commitPlaying(false);
        setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      const currentFront = djEngine.frontElement();
      if (currentFront !== frontElRef.current) setFrontEl(currentFront);
      if (transportFade) {
        void djEngine.softPause().catch((error: unknown) =>
          setNotice(`暂停当前播放失败：${error instanceof Error ? error.message : String(error)}`),
        );
      } else {
        djEngine.cancel();
        djEngine.hardPause(currentFront);
      }
    }
    commitPlaying(nextPlaying);
  }, [nativePlayer, commitPlaying, transportFade, retainedDecks, visualActiveIndex]);

  /**
   * 原生 MPRemoteCommandCenter/SMTC 与 WebView Media Session 都汇入主按钮的唯一入口。
   * 某些系统会把一次实体按键同时送到两处；短窗口只吞同一次上报，不影响普通点击。
   */
  const handleSystemMediaAction = useCallback(
    (action: SystemMediaAction) => {
      const now = performance.now();
      if (now - lastSystemMediaAtRef.current < SYSTEM_MEDIA_DEDUPE_MS) return;
      lastSystemMediaAtRef.current = now;

      if (action === "next") {
        void remoteNextRef.current();
        return;
      }
      if (action === "previous") {
        void remotePreviousRef.current();
        return;
      }

      const pip = useVideoPip.getState();
      const currentlyPlaying = networkVideoOwnsTransport(
        pip.session,
        pip.active,
        pip.failed,
      )
        ? pip.playing
        : playingRef.current;
      const requestedPlaying =
        action === "play" ? true : action === "pause" ? false : !currentlyPlaying;
      // Windows SMTC 会按当前状态发出明确的 Play/Pause。重复的同态命令不是 toggle，
      // 不能把已经暂停的流重新拉起来。
      if (requestedPlaying === currentlyPlaying) return;
      toggleTransport();
    },
    [toggleTransport],
  );
  systemMediaActionRef.current = handleSystemMediaAction;

  // 仅 standalone browser adapter 由 Web Audio 持有。显式接管 Web Media Session，
  // 避免浏览器默认 pause HTMLMediaElement 绕过淡出包络；Tauri 壳的在线流不会进入这里。
  useEffect(() => {
    if (!track || nativePlayer || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // 旧版 WebKit 可能暴露 mediaSession 却不支持某个 action。
      }
    };
    bind("play", () => systemMediaActionRef.current("play"));
    bind("pause", () => systemMediaActionRef.current("pause"));
    bind("nexttrack", () => systemMediaActionRef.current("next"));
    bind("previoustrack", () => systemMediaActionRef.current("previous"));

    const cover = playbackCoverUrl(track);
    if (typeof MediaMetadata !== "undefined") {
      try {
        session.metadata = new MediaMetadata({
          title: track.title || track.filename,
          artist: track.artist || "",
          album: track.album || "",
          artwork: cover ? [{ src: cover }] : undefined,
        });
      } catch {
        // 元数据失败不应影响实体播放键。
      }
    }

    return () => {
      for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // 同上：只清理当前运行时真正支持的 action。
        }
      }
      try {
        session.metadata = null;
        session.playbackState = "none";
      } catch {
        // 页面/HMR 正在拆卸时忽略媒体会话清理失败。
      }
    };
  }, [track, nativePlayer]);

  useEffect(() => {
    if (!track || nativePlayer || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch {
      // 播放本身不依赖系统状态镜像。
    }
  }, [track?.id, nativePlayer, playing]);

  /** 相对跳转：网络预览走 PiP 事件，曲库曲目走 SEEK_EVENT（和点波形同一条路）。 */
  const seekBy = useCallback((delta: number) => {
    const pip = useVideoPip.getState();
    if (networkVideoOwnsTransport(pip.session, pip.active, pip.failed)) {
      const total = pip.duration;
      const next =
        total > 0
          ? Math.min(total, Math.max(0, pip.position + delta))
          : Math.max(0, pip.position + delta);
      // 立刻写回 store，连按才不会都基于同一个旧进度。
      useVideoPip.getState().setPosition(next);
      seekVideoPip(next);
      return;
    }
    const current = trackRef.current;
    if (!current) return;
    const total = durationRef.current || current.duration || 0;
    const next =
      total > 0
        ? Math.min(total, Math.max(0, positionRef.current + delta))
        : Math.max(0, positionRef.current + delta);
    positionRef.current = next;
    setPosition(next);
    window.dispatchEvent(
      new CustomEvent<SeekDetail>(SEEK_EVENT, {
        detail: { trackId: current.id, position: next },
      }),
    );
  }, []);

  usePlayerShortcuts({
    togglePlay: (source) => {
      if (source === "media-key") systemMediaActionRef.current("toggle");
      else toggleTransport();
    },
    seekBy,
    nudgeVolume: (delta) => {
      setMasterVolume(playerVolumeRef.current + delta);
    },
    moveListSelection: (delta) => {
      window.dispatchEvent(
        new CustomEvent<ArrowKeyListStepDetail>(ARROW_KEY_LIST_STEP_EVENT, {
          detail: { delta },
        }),
      );
    },
    goNext: () => {
      void goNext();
    },
    goPrevious: () => {
      void goPrevious();
    },
  });

  // 右侧在线详情/歌词面只发命令；真正的 transport 仍由这一条播放器独占。
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<PlayerCommand>).detail;
      if (!command) return;
      if (command.type === "toggle") {
        toggleTransport();
      } else if (command.type === "next") {
        void remoteNextRef.current();
      } else if (command.type === "previous") {
        void remotePreviousRef.current();
      } else if (command.type === "seek") {
        const current = trackRef.current;
        if (!current) return;
        const total = durationRef.current || current.duration || 0;
        const at = total > 0
          ? Math.min(total, Math.max(0, command.position))
          : Math.max(0, command.position);
        positionRef.current = at;
        setPosition(at);
        window.dispatchEvent(
          new CustomEvent<SeekDetail>(SEEK_EVENT, {
            detail: { trackId: current.id, position: at, forceCommit: true },
          }),
        );
      }
    };
    window.addEventListener(PLAYER_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(PLAYER_COMMAND_EVENT, onCommand);
  }, [toggleTransport]);

  /**
   * <audio> 的事件监听挂在"当前正主"元素上。接歌互换正主后这个 effect
   * 随 frontEl 重跑，监听自动搬家——旧 deck 在暗处退场时的 timeupdate /
   * ended 不会再打进 UI。这也是不再用 JSX 渲染 <audio> 的代价与回报。
   */
  useEffect(() => {
    // HTMLMediaElement events belong only to the browser preview owner. Native desktop/Android
    // snapshots are authoritative for local and online tracks alike.
    if (nativePlayer) return;
    const audio = frontEl;
    const onTime = () => {
      // 主按钮进入“暂停”状态后，媒体还会继续运行半秒来完成淡出。播放头必须
      // 跟到真正的 pause 点；若在这段时间丢弃 timeupdate，UI 会停在旧位置，
      // 下一次播放收到首个 timeupdate 时就会把这半秒一次性补跳出来。
      // shadow deck 准备时旧声仍在走，但不能让旧时钟把刚点击的播放头拉回去。
      if (djEngine.isSeeking()) return;
      const seconds = djEngine.currentTime(audio);
      // 与原生订阅同一套：scrub 拖动中不让时钟把播放头顶回去。
      if (!scrubbingRef.current) {
        setPosition(seconds);
      }
      broadcast(seconds);
      broadcastMediaSync({
        owner: "player",
        action: "position",
        trackId: track?.id,
        position: seconds,
        rate: audio.playbackRate,
      });
      if (isStreamTrack(track)) {
        publishStreamTrackState(track, seconds, playing, audio.playbackRate);
      }
      // 曲末自动接歌：优先结束点（开关开着时），其次频谱尾段，再按过渡长度倒推。
      // 太短的音频（demo/音效）不接。
      if (!playing || !track) return;
      if (dualDeck) return;
      // 未开 DJ 时：开关开着且有结束点 → 到点硬切下一首；与 ended 事件共用
      // 同一条入口，避免结束点和 ended 各消费一次队列。
      if (
        !djEnabled &&
        applyInOutPoints &&
        track.end_ms != null &&
        seconds >= track.end_ms / 1000 &&
        !endedAdvanceRef.current
      ) {
        continueAfterEnded(track);
        return;
      }
      if (!djEnabled) return;
      const total =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : (track.duration ?? 0);
      // 用户设了结束点时不论长短都按点切；没设时太短的 demo/音效不接。
      if (total < 30 && !(applyInOutPoints && track.end_ms != null)) return;
      const remain = total - seconds;
      if (remain <= 0) return;
      const outro = djOutroRef.current;
      const mixLead = mixSeconds(track.bpm, djBars);
      const outroDue =
        outro.trackId === track.id && outro.at !== null && seconds >= outro.at;
      const remainDue = remain > 0 && remain <= mixLead;
      const due = outroDue || remainDue;
      if (
        due &&
        !djBusyRef.current &&
        !nativeDjBusyRef.current &&
        !djEngine.isTransitioning() &&
        djGaveUpRef.current !== track.id
      ) {
        void djNext(false);
      }
    };
    const onMeta = () => {
      const value = audio.duration;
      // 无损/VBR 文件偶尔给 Infinity，这时退回曲库里存的时长
      if (Number.isFinite(value) && value > 0) setDuration(value);
      if (isStreamTrack(track)) setBrowserMediaStatus(playing ? "playing" : "paused");
    };
    const onLoadStart = () => {
      if (isStreamTrack(track)) setBrowserMediaStatus("loading");
    };
    const onWaiting = () => {
      if (isStreamTrack(track)) setBrowserMediaStatus("buffering");
    };
    const onCanPlay = () => {
      if (isStreamTrack(track)) setBrowserMediaStatus(playingRef.current ? "playing" : "paused");
    };
    const onMediaPlaying = () => {
      if (isStreamTrack(track)) setBrowserMediaStatus("playing");
    };
    const onPause = () => {
      if (isStreamTrack(track) && !audio.ended) setBrowserMediaStatus("paused");
    };
    const onEnded = () => {
      if (isStreamTrack(track)) setBrowserMediaStatus("ended");
      continueAfterEnded(track);
    };
    const onError = () => {
      if (track) {
        if (trackRef.current?.id !== track.id) return;
        const wasPlaying = playingRef.current;
        commitPlaying(false);
        if (isStreamTrack(track)) {
          const retrySource = wasPlaying ? claimStreamCacheRetry(track) : null;
          if (retrySource) {
            setBrowserMediaStatus("loading");
            setNotice("本地缓存或在线地址异常，正在重新连接…");
            void playSongPreview({
              source: retrySource,
              title: track.title,
              artist: track.artist,
              autoPlay: true,
              bypassCache: true,
            }).catch((reason: unknown) => {
              if (trackRef.current?.id === track.id) {
                setBrowserMediaStatus("error");
                setNotice(
                  `在线试听重试失败：${reason instanceof Error ? reason.message : String(reason)}`,
                );
              }
            });
            return;
          }
          setBrowserMediaStatus("error");
          setNotice("在线试听无法播放，直链可能已经过期，请重试");
        } else {
          setNotice("这个文件放不了，可能已被移动，或者格式浏览器不支持");
        }
      }
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("loadstart", onLoadStart);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("stalled", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("playing", onMediaPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("loadstart", onLoadStart);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("stalled", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("playing", onMediaPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [frontEl, track, playing, djEnabled, djBars, applyInOutPoints, broadcast, djNext, nativePlayer, commitPlaying, continueAfterEnded, dualDeck]);

  // 在线底栏波形随真实播放逐步长出来：AnalyserNode 只读取当前已经解码的声音，
  // media.buffered 只负责标记缓存占位，二者都不发第二份整轨网络请求。
  //
  // 不能只靠 rAF：Tauri 窗口隐藏/失焦后 WebView 会暂停或重度节流动画帧，声音仍在走，
  // 结果就是回到窗口时播放头前进了、波形却断了一大截。前台保留 rAF，后台改用
  // 低频 interval，并让媒体自己的 timeupdate/playing/seeked 补采样。所有入口共用
  // lastSampleAt/lastPosition，事件和定时器撞在一起时不会重复复制 640 桶快照。
  useEffect(() => {
    // 正式桌面/Android 在线流不再经过 HTMLMediaElement；真实波形由下面同一份
    // 回环代理缓存前缀生成。Analyser 只保留给纯浏览器 preview adapter。
    if (!track || !isStreamTrack(track) || nativePlayer) return;
    const audio = frontEl;
    const trackId = track.id;
    let frame = 0;
    let fallbackTimer = 0;
    let disposed = false;
    let lastSampleAt = Number.NEGATIVE_INFINITY;
    let lastPosition = Number.NEGATIVE_INFINITY;

    const totalDuration = () => {
      const mediaDuration = audio.duration;
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
      return durationRef.current || track.duration || 0;
    };
    const update = (
      sample: ReturnType<typeof djEngine.waveformSample>,
      position = djEngine.currentTime(audio),
    ) => {
      const total = totalDuration();
      updateStreamWaveform(
        trackId,
        position,
        total,
        sample,
        mediaBufferedRanges(audio, total),
      );
    };
    const onProgress = () => update(null);

    const isBackground = () =>
      document.visibilityState !== "visible" || !document.hasFocus();

    const canSample = () =>
      !audio.paused &&
      !audio.ended &&
      !audio.seeking &&
      audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

    const sampleNow = (now = performance.now()) => {
      if (disposed || !canSample()) return;
      const minimumInterval = isBackground()
        ? STREAM_WAVEFORM_BACKGROUND_MS
        : STREAM_WAVEFORM_FOREGROUND_MS;
      if (now - lastSampleAt < minimumInterval) return;

      const at = djEngine.currentTime(audio);
      if (!Number.isFinite(at) || at < 0) return;
      // stalled/timeupdate 在播放头没有前进时也可能重复触发；同一解码瞬间不重复聚合。
      if (Math.abs(at - lastPosition) < 0.004) return;
      const sample = djEngine.waveformSample(audio);
      if (!sample) return;

      lastSampleAt = now;
      lastPosition = at;
      update(sample, at);
    };

    const tick = (now: number) => {
      if (disposed) return;
      sampleNow(now);
      frame = requestAnimationFrame(tick);
    };

    const stopDriver = () => {
      if (frame) cancelAnimationFrame(frame);
      if (fallbackTimer) clearInterval(fallbackTimer);
      frame = 0;
      fallbackTimer = 0;
    };

    const startDriver = () => {
      stopDriver();
      if (disposed || audio.paused || audio.ended) return;
      // 可见且有焦点时 rAF 最省；后台定时器即使被 WebView 钳到 1fps，仍有
      // timeupdate 作为第二条真实媒体时钟，不会像纯 rAF 那样完全停住。
      if (!isBackground()) {
        frame = requestAnimationFrame(tick);
      } else {
        fallbackTimer = window.setInterval(
          () => sampleNow(),
          STREAM_WAVEFORM_BACKGROUND_MS,
        );
      }
    };

    const onMediaTick = () => sampleNow();
    const onPlaying = () => {
      sampleNow();
      startDriver();
    };
    const onPlaybackStop = () => {
      onProgress();
      startDriver();
    };
    const onVisibilityOrFocus = () => {
      startDriver();
      sampleNow();
    };

    audio.addEventListener("progress", onProgress);
    audio.addEventListener("loadedmetadata", onProgress);
    audio.addEventListener("durationchange", onProgress);
    audio.addEventListener("canplay", onProgress);
    audio.addEventListener("timeupdate", onMediaTick);
    audio.addEventListener("seeked", onMediaTick);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPlaybackStop);
    audio.addEventListener("ended", onPlaybackStop);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);
    window.addEventListener("blur", onVisibilityOrFocus);
    onProgress();
    startDriver();
    return () => {
      disposed = true;
      stopDriver();
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("loadedmetadata", onProgress);
      audio.removeEventListener("durationchange", onProgress);
      audio.removeEventListener("canplay", onProgress);
      audio.removeEventListener("timeupdate", onMediaTick);
      audio.removeEventListener("seeked", onMediaTick);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPlaybackStop);
      audio.removeEventListener("ended", onPlaybackStop);
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
      window.removeEventListener("focus", onVisibilityOrFocus);
      window.removeEventListener("blur", onVisibilityOrFocus);
    };
  }, [frontEl, track?.id, nativePlayer]);

  // 当前主唱盘与 Performance A/B 共用按 token 去重的分析租约。轮询只读取代理已经
  // 落盘的媒体；不会创建第二份下载，也不会因一首在线歌装在非焦点 Deck 就断链。
  useEffect(() => {
    if (!track || !isStreamTrack(track) || !activeStreamWaveformToken) return;
    const audio = frontEl;
    return subscribeStreamAnalysisPoll(track, activeStreamWaveformToken, {
      duration: () => {
        const mediaDuration = audio.duration;
        if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
        return durationRef.current || track.duration || 0;
      },
      ended: () => nativePlayer ? nativePlayer.state().status === "ended" : audio.ended,
    });
  }, [frontEl, track?.id, activeStreamWaveformToken, nativePlayer]);

  // 跳转统一由 Waveform 发 kd:seek 事件，上面那个监听负责落到 <audio> 上

  // 在放的优先；重新打开软件时先恢复上次留在正主 deck 的曲目。只有没有可恢复
  // 唱盘时才拿列表选中项兜底——普通单击文件夹/列表不能让“下一首”闪一下。
  const retainedCurrentTrack = retainedDecks[visualActiveIndex];
  const hadRememberedDeck =
    deckMemoryRef.current.leftId !== null || deckMemoryRef.current.rightId !== null;
  const displayTrack =
    track ??
    retainedCurrentTrack ??
    (retainedDecksLoaded || !hadRememberedDeck ? selected : null);
  // 按钮启用态和 goNext 必须读同一来源：会话恢复/仅选中时 UI 已有正主，
  // 不能因为 React 的正式 track 还没提升就把“下一首”画成不可点。
  currentAdvanceTrackRef.current = displayTrack;
  // 网络视频画中画活跃时，标题区让位给视频会话（音频 track 可能仍挂着被暂停的歌）
  const streaming = isStreamTrack(displayTrack);
  // 小窗/系统 PiP / 网络右栏：底栏信息与进度交给预览会话。
  // 本地 + 面板档仍走曲库详情 LocalVideoPlayer，底栏保持普通音轨波形。
  const pipDriving =
    pipActive &&
    Boolean(pipSession) &&
    !(pipFailed && pipSession?.source === "network") &&
    !(pipSession?.source === "local" && pipMode === "panel");
  const transportLoading = Boolean(
    !pipDriving &&
      streaming &&
      !playing &&
      (isUnresolvedStreamTrack(displayTrack) ||
        nativeLoadInFlightRef.current ||
        browserMediaStatus === "resolving" ||
        browserMediaStatus === "loading" ||
        browserMediaStatus === "buffering"),
  );
  const transportLoadingLabel = browserMediaStatus === "buffering"
    ? "正在缓冲"
    : isUnresolvedStreamTrack(displayTrack) || browserMediaStatus === "resolving"
      ? "正在解析播放地址"
      : "正在加载";
  const titleText = pipDriving && pipSession
    ? pipSession.title || "视频预览"
    : displayTrack
      ? displayTrack.title || displayTrack.filename
        : "没有在播的曲目";
  // 没有艺人时垫一个 nbsp 而不是空串：空内容不产生行盒，第二行会塌掉，
  // 换到一首没艺人的歌整条播放条的字就往下跳一下
  const video = Boolean(
    (pipDriving && pipSession) || (displayTrack && isVideoTrack(displayTrack.format)),
  );
  const networkPreview = Boolean(pipDriving && pipSession?.source === "network");
  // 同一颗按钮按当前媒体解释：音频控制悬浮歌词，本地视频控制详情/小窗。
  // B 站搜索结果固定浮动预览，不读取也不改这项本地视频偏好。
  const sharedFloatOn = networkPreview ? true : video ? pipMode === "float" : desktopLyricsOn;
  /**
   * Android 的悬浮歌词要「显示在其他应用上层」权限，必须先拿到再翻开关，
   * 否则开关亮着而屏幕上什么都没有。桌面不需要该权限，直接翻。
   */
  const toggleLyricsOverlay = async () => {
    if (desktopLyricsOn) {
      setDesktopLyricsOn(false);
      return;
    }
    if (await ensureOverlayPermission()) {
      setDesktopLyricsOn(true);
      return;
    }
    setNotice(
      "悬浮歌词需要「显示在其他应用上层」权限。部分定制系统还要额外允许「后台弹出界面」，否则授权了也不显示。",
    );
  };
  const artistText = pipDriving && pipSession
    ? pipSession.author || "\u00a0"
    : displayTrack?.artist || "\u00a0";
  const coverSrc = (() => {
    if (pipDriving && pipSession?.source === "local") {
      return api.coverUrl(
        pipSession.trackId,
        track?.id === pipSession.trackId ? track.modified_at : undefined,
      );
    }
    if (pipDriving && pipSession?.source === "network") {
      const cover = pipSession.cover?.trim() || "";
      return cover ? thumbUrl(cover, 96) : "";
    }
    if (!displayTrack) return "";
    return playbackCoverUrl(displayTrack);
  })();
  const discKey = pipDriving && pipSession
    ? pipSession.source === "local"
      ? `local:${pipSession.trackId}`
      : `network:${pipSession.bvid}:${pipSession.page}`
    : displayTrack
      ? `library:${displayTrack.id}`
      : "";
  const currentDeckView: PlayerDeckView | null = displayTrack || pipDriving
    ? {
        key: discKey,
        track: displayTrack,
        title: titleText,
        subtitle: video
          ? pipDriving
            ? pipSystem
              ? "系统画中画"
              : networkPreview
                ? "浮动预览"
                : pipMode === "panel"
                  ? "详情预览"
                  : "浮动预览"
            : "视频"
          : artistText,
        cover: coverSrc,
        video,
      }
    : null;

  const retainedNextTrack = retainedDecks[visualActiveIndex === 0 ? 1 : 0];
  const predictionBase = track ?? retainedCurrentTrack ?? (retainedDecksLoaded ? selected : null);
  const predictionFolder = scope === "folder" ? libraryFolder : "";
  const predictionSort = mode === "order" ? librarySort : "";
  const predictionOrder = mode === "order" ? libraryOrder : "";

  // 当前曲、播放模式或有效范围一变，就给空闲 deck 做一次只读预测。
  // UI 在请求期间保留旧封面防闪烁，但先清掉可消费 ref 和策略票据：用户若恰好
  // 此时按下一首，pickNext 会按新模式现场重算，绝不会把旧预告送进 Deck。
  // 依赖只放真正参与算法的值，单击无关文件夹/列表不会重跑，这是“下一首闪动”的根因修复。
  useEffect(() => {
    const base = predictionBase;
    const epoch = ++predictionEpochRef.current;
    predictedRef.current = null;
    predictedPolicyRef.current = null;
    if (dualDeck) {
      setPredicted(null);
      return;
    }
    if (!base) {
      setPredicted(null);
      return;
    }
    // 策略必须在请求发起这一刻冻结。异步完成时再读 store 会把旧模式挑出的歌
    // 错贴成新模式票据，恰好绕过下面的 epoch/mode 校验。
    const generatedPolicy = predictionPolicyNow(base.id, epoch);
    // 首次进入先原样保留上次的另一台唱盘；真正换曲/改模式/改范围后再重新预测。
    if (
      useRetainedNextOnceRef.current &&
      !track &&
      retainedNextTrack &&
      retainedNextTrack.id !== base.id
    ) {
      useRetainedNextOnceRef.current = false;
      predictedRef.current = retainedNextTrack;
      predictedPolicyRef.current = generatedPolicy;
      setPredicted(retainedNextTrack);
      return;
    }
    useRetainedNextOnceRef.current = false;
    let alive = true;
    // “下一首”唱盘描述的是用户按下一首键后会听到什么。单曲循环只影响自动续播；
    // 用户手动下一首仍应预告另一首，不能把当前曲复制到另一台并标成“下一首”。
    void previewNext(base, mode === "one").then((next) => {
      if (!alive || predictionEpochRef.current !== epoch) return;
      const distinct = next?.id === base.id ? null : next;
      predictedRef.current = distinct;
      predictedPolicyRef.current = distinct ? generatedPolicy : null;
      setPredicted(distinct);
    });
    return () => {
      alive = false;
    };
  }, [
    track?.id,
    predictionBase?.id,
    retainedNextTrack?.id,
    dualDeck,
    mode,
    scope,
    predictionFolder,
    predictionSort,
    predictionOrder,
    pipDriving,
  ]);

  // 范围 / 模式 / 文件夹一变，作废后台 Deck 预热，避免 handoff 接到旧预告上。
  useEffect(() => {
    nativePreparedRef.current = null;
  }, [scope, predictionFolder, mode, librarySort, libraryOrder]);

  // 纯浏览器开发 adapter 仍用 Web Audio 双 Deck；正式 Tauri 壳由下面的 Rust
  // prepare 路径统一预热，本 effect 不得再创建第二条正式输出链。
  useEffect(() => {
    if (
      nativePlayer ||
      dualDeck ||
      !djEnabled ||
      !track ||
      !predicted ||
      predicted.id === track.id ||
      djTransition.phase !== "idle"
    ) {
      return;
    }
    const browserHandoff =
      browserDjSession || isStreamTrack(track) || isStreamTrack(predicted);
    if (!browserHandoff) return;

    let alive = true;
    const fromId = track.id;
    const predictedId = predicted.id;
    const intent = playbackIntentRef.current;
    void (async () => {
      await ensurePlaybackTrackReady(predicted);
      if (
        !alive ||
        playbackIntentRef.current !== intent ||
        djEngine.isTransitioning() ||
        trackRef.current?.id !== fromId ||
        predictedRef.current?.id !== predictedId
      ) {
        return;
      }
      const config = useDjConfig.getState();
      const fromRate =
        !browserDjSession && !isStreamTrack(track)
          ? playerRuntime.state().rate
          : djEngine.frontElement().playbackRate;
      djEngine.prepareNext(
        predicted,
        {
          transitions: config.transitions,
          effects: config.effects,
          from: track,
          bars: config.bars,
          vocalCut: config.vocalCut,
          applyInOutPoints: config.applyInOutPoints,
          autoBeatSync: config.autoBeatSync,
        },
        fromRate,
      );
    })().catch(() => {
      // 预测预热是优化路径。流地址过期或浏览器拒绝预载时，begin 仍会保留旧歌
      // 并走既有 canplay 等待，不能让后台失败打断当前正在出声的曲目。
    });
    return () => {
      alive = false;
    };
  }, [
    nativePlayer,
    dualDeck,
    djEnabled,
    browserDjSession,
    djTransition.phase,
    track?.id,
    predicted?.id,
    playing,
    djBars,
    applyInOutPoints,
  ]);

  // 正式桌面播放器在预测结果出来后就让 Rust 流式预读第二台 Deck。普通切歌和
  // DJ 都复用这份有界缓冲；按钮只提交切换命令，不在交互路径整轨解码。
  useEffect(() => {
    if (dualDeck || !desktopNative || !nativePlayer?.supportsRealtimeDj || !track || !predicted) {
      nativePreparedRef.current = null;
      return;
    }
    // React 仍可能展示上一轮预测的封面；只有策略票据已落地、可消费 ref 与它
    // 一致时才允许 Rust 预热，避免模式切换瞬间把旧候选重新塞进原生 Deck。
    if (predictedRef.current?.id !== predicted.id) {
      nativePreparedRef.current = null;
      return;
    }
    if (predicted.id === track.id) return;
    const currentRate = nativePlayer.state().rate || 1;
    const effectiveFromBpm = track.bpm ? track.bpm * currentRate : null;
    // Prewarm and final prepare must agree exactly. Otherwise `same_source` rejects the warm Deck
    // at the transition boundary and starts another decoder just when both Decks need CPU.
    const rate = automaticTransitionRate(
      djEnabled && autoBeatSync,
      effectiveFromBpm,
      predicted.bpm,
    );
    const cue = djEnabled
      ? applyInOutPoints && predicted.cue_ms !== null
        ? predicted.cue_ms / 1000
        : (predicted.first_beat ?? 0)
      : applyInOutPoints && predicted.cue_ms !== null
        ? predicted.cue_ms / 1000
        : 0;
    const generation = ++nativePrepareGenerationRef.current;
    nativePreparedRef.current = null;
    void (async () => {
      await ensurePlaybackTrackReady(predicted);
      if (generation !== nativePrepareGenerationRef.current) return;
      await nativePlayer.prepare({
        src: mediaUrlForTrack(predicted),
        track: predicted,
        position: cue,
        rate,
      });
      if (generation !== nativePrepareGenerationRef.current) return;
      nativePreparedRef.current = { fromId: track.id, trackId: predicted.id, rate, cue };
    })().catch(() => {
      if (generation === nativePrepareGenerationRef.current) nativePreparedRef.current = null;
    });
    return () => {
      if (generation === nativePrepareGenerationRef.current) {
        nativePrepareGenerationRef.current += 1;
      }
    };
  }, [
    desktopNative,
    nativePlayer,
    dualDeck,
    djEnabled,
    scope,
    predictionFolder,
    track?.id,
    track?.bpm,
    predicted?.id,
    predicted?.bpm,
    predicted?.cue_ms,
    predicted?.first_beat,
    applyInOutPoints,
    autoBeatSync,
  ]);

  const transitionShowing = djTransition.phase !== "idle" && transitionVisual !== null;
  // 最后一层视觉约束：无论异步预测、会话恢复还是播放器 ACK 以什么顺序到达，
  // 非当前唱盘都不能再拿当前曲目的同一个 id 冒充“下一首”。
  const visiblePredicted = predicted?.id === currentDeckView?.track?.id ? null : predicted;
  const predictedDeckView = visiblePredicted ? viewForTrack(visiblePredicted) : null;
  let leftDeckView: PlayerDeckView | null;
  let rightDeckView: PlayerDeckView | null;
  if (transitionShowing) {
    const outgoingView = viewForTrack(transitionVisual.from);
    const incomingView = viewForTrack(transitionVisual.next);
    leftDeckView = transitionVisual.outgoingIndex === 0 ? outgoingView : incomingView;
    rightDeckView = transitionVisual.outgoingIndex === 1 ? outgoingView : incomingView;
  } else {
    leftDeckView = visualActiveIndex === 0 ? currentDeckView : predictedDeckView;
    rightDeckView = visualActiveIndex === 1 ? currentDeckView : predictedDeckView;
  }
  if (dualDeck && !transitionShowing) {
    // Physical side is the one source of truth. Provider kind, active-player focus, retained
    // prediction and async stream resolution only contribute Track metadata candidates; none of
    // them can put a row on a side whose coordinator track id does not match.
    // Pending installs are the sole exception: cover/title must appear before the provider URL
    // and LoadDeck ACK arrive, otherwise double-click looks like a no-op on slow platforms.
    const preparedTrackId = playerRuntime.state().preparedTrackId;
    const physicalTracks = bindTracksToPhysicalDecks(
      [performanceDeckStates[0].trackId, performanceDeckStates[1].trackId],
      performanceDeckOverrides,
      [
        currentDeckView?.track,
        ...retainedDecks.map((candidate) =>
          candidate?.id === preparedTrackId ? null : candidate,
        ),
      ],
    );
    leftDeckView = performancePendingDecks[0]
      ? viewForTrack(performancePendingDecks[0])
      : physicalTracks[0]
        ? viewForTrack(physicalTracks[0])
        : null;
    rightDeckView = performancePendingDecks[1]
      ? viewForTrack(performancePendingDecks[1])
      : physicalTracks[1]
        ? viewForTrack(physicalTracks[1])
        : null;
  }
  const deckPlaying = pipDriving && pipSession?.source === "network" ? pipPlaying : playing;
  const playbackVisualRate = pipDriving
    ? 1
    : (nativePlayer?.state().rate ?? frontEl.playbackRate ?? 1);
  const playbackPosition = pipDriving ? pipPosition : position;
  // 音频元数据尚未加载（例如恢复上次的唱盘）时，曲库已有的时长仍应先显示；
  // 否则波形都在却只剩一串 --:--，看不出整首还有多久。
  const playbackDuration = pipDriving ? pipDuration : duration || displayTrack?.duration || 0;
  const elapsed = Math.max(0, Math.min(playbackDuration, playbackPosition));
  const remaining = Math.max(0, playbackDuration - playbackPosition);
  // 随机播放的右唱盘只是预告，不必先切走正在放的歌才能换一个候选。
  const canRefreshPrediction =
    mode === "shuffle" &&
    Boolean(predictionBase) &&
    Boolean(predicted) &&
    !isStreamTrack(predictionBase);
  const refreshPrediction = async () => {
    const base = predictionBase;
    if (!base || refreshingPrediction) return;
    const previous = predictedRef.current;
    const epoch = ++predictionEpochRef.current;
    const generatedPolicy = predictionPolicyNow(base.id, epoch);
    // 刷新期间旧预告只负责留在画面上，不能被下一首按钮兑现。
    predictedRef.current = null;
    predictedPolicyRef.current = null;
    setRefreshingPrediction(true);
    try {
      const excluded = new Set<number>([base.id]);
      if (previous) excluded.add(previous.id);
      const next = await previewNext(base, false, excluded);
      if (predictionEpochRef.current !== epoch) return;
      // 候选已经没有别首可换时保留眼前这首，不把右唱盘无故清空。
      if (next) {
        predictedRef.current = next;
        predictedPolicyRef.current = generatedPolicy;
        setPredicted(next);
      } else if (previous) {
        predictedRef.current = previous;
        predictedPolicyRef.current = generatedPolicy;
      }
    } finally {
      setRefreshingPrediction(false);
    }
  };

  // 两台唱盘及正主方向跨会话保留。网络试听没有稳定的曲库 id，不写进存档。
  useEffect(() => {
    if (transitionShowing) return;
    const leftId = leftDeckView?.track && usesLocalLibraryRecord(leftDeckView.track)
      ? leftDeckView.track.id
      : deckMemoryRef.current.leftId;
    const rightId = rightDeckView?.track && usesLocalLibraryRecord(rightDeckView.track)
      ? rightDeckView.track.id
      : deckMemoryRef.current.rightId;
    if (leftId === null && rightId === null) return;
    const memory: PlayerDeckMemory = {
      ...deckMemoryRef.current,
      leftId,
      rightId,
      activeIndex: visualActiveIndex,
    };
    deckMemoryRef.current = memory;
    writeLocalStorageSoon(PLAYER_DECK_MEMORY_KEY, JSON.stringify(memory), 250);
  }, [
    transitionShowing,
    leftDeckView?.track?.id,
    rightDeckView?.track?.id,
    visualActiveIndex,
  ]);

  // 活动曲目的暂停位置也属于会话状态。固定窗口合并写入，播放时不会按每个时钟帧
  // 敲磁盘；pagehide/beforeunload 会把最后一个尚未到期的窗口统一 flush。
  useEffect(() => {
    if (!usesLocalLibraryRecord(track)) return;
    const memory: PlayerDeckMemory = {
      ...deckMemoryRef.current,
      positionTrackId: track.id,
      position: Math.max(0, Number.isFinite(position) ? position : 0),
    };
    deckMemoryRef.current = memory;
    writeLocalStorageSoon(PLAYER_DECK_MEMORY_KEY, JSON.stringify(memory), 1_000);
  }, [track?.id, position]);

  const lastDeckOpenRef = useRef<{ trackId: number; at: number } | null>(null);
  const openDeck = (view: PlayerDeckView | null, active: boolean) => {
    const deckTrack = view?.track;
    if (!deckTrack) return;
    // 竖屏时右栏是整屏 Sheet。只有正在播放的那张唱盘才是详情入口；下一首
    // 只能作为预告，点它不能把当前列表整个遮住。
    if (portrait && !active) return;
    // Android WebView 可能把一次触摸补发成 pointer/click 两套事件；短窗口内
    // 同一唱盘只发布一次定位事件，避免详情状态在同一帧反复切换。
    const now = performance.now();
    const last = lastDeckOpenRef.current;
    if (last && last.trackId === deckTrack.id && now - last.at < 400) return;
    lastDeckOpenRef.current = { trackId: deckTrack.id, at: now };
    if (usesLocalLibraryRecord(deckTrack) && selected?.id !== deckTrack.id) selectTrack(deckTrack);
    window.dispatchEvent(
      new CustomEvent(DETAIL_EVENT, {
        detail: { source: "player-deck", trackId: deckTrack.id },
      }),
    );
  };

  const dropOnDeck = async (
    event: React.DragEvent<HTMLElement>,
    side: "left" | "right",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setDeckDropSide(null);
    let request: PlaybackTrackRequest | null = null;
    if (isSearchAudioDrag(event)) {
      const source = searchAudioSource(readSearchDrop(event.dataTransfer));
      finishSearchDrop();
      request = source ? songSourceRequest(source) : null;
    } else if (isTrackDrag(event)) {
      const ids = readTrackDragIds(event.dataTransfer);
      finishTrackDrop();
      const id = ids[0];
      if (id != null) request = trackIdRequest(id);
    }
    const first = request ? await resolvePlaybackTrack(request).catch(() => null) : null;
    if (!first) {
      setNotice("拖入的歌曲来源已经失效");
      return;
    }
    const sideIndex: 0 | 1 = side === "left" ? 0 : 1;
    const droppingOnCurrent = sideIndex === visualActiveIndex;
    if (dualDeck && playerRuntime.supportsRealtimeDj) {
      await loadPerformanceTrackRef.current(sideIndex, first, droppingOnCurrent);
      return;
    }
    if (droppingOnCurrent) {
      playTrack(first);
      return;
    }
    const base = trackRef.current;
    const epoch = ++predictionEpochRef.current;
    predictedRef.current = first;
    predictedPolicyRef.current = base ? predictionPolicyNow(base.id, epoch) : null;
    setPredicted(first);
    setNotice(`下一首已替换为：${first.title || first.filename}`);
  };

  const deckDragOver = (
    event: React.DragEvent<HTMLElement>,
    side: "left" | "right",
  ) => {
    if (!isTrackDrag(event) && !isSearchAudioDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDeckDropSide(side);
  };

  const downloadStreamTrack = (streamTrack: Track | null) => {
    const source = streamTrack && isStreamTrack(streamTrack) ? streamMeta(streamTrack)?.source : null;
    if (!source || enqueueBusy) return;
    setEnqueueBusy(true);
    void enqueueMediaDownloads([source], { quality: defaultQuality })
      .catch((error: unknown) => {
        setNotice(`下载失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setEnqueueBusy(false));
  };

  const canDownloadStreamTrack = (streamTrack: Track | null) =>
    Boolean(streamTrack && isStreamTrack(streamTrack) && streamMeta(streamTrack)?.source);

  const performanceStateFor = (side: 0 | 1, deckTrack: Track | null) => {
    const state = performanceDeckStates[side];
    return deckTrack && state.trackId === deckTrack.id ? state : null;
  };
  const deckTransportSeconds = (side: 0 | 1, deckTrack: Track | null) => {
    const bound = performanceStateFor(side, deckTrack);
    if (bound) return bound.currentTime;
    if (deckTrack && track?.id === deckTrack.id) return playbackPosition;
    const native = performanceDeckStates[side];
    if (deckTrack && native.trackId === deckTrack.id) return native.currentTime;
    return playbackPosition;
  };
  const leftPerformanceState = performanceStateFor(0, leftDeckView?.track ?? null);
  const rightPerformanceState = performanceStateFor(1, rightDeckView?.track ?? null);
  const performanceDecks: [PerformanceDeckModel, PerformanceDeckModel] = [
    {
      track: leftDeckView?.track ?? null,
      active: visualActiveIndex === 0,
      position: deckTransportSeconds(0, leftDeckView?.track ?? null),
      duration:
        leftPerformanceState?.duration ??
        (visualActiveIndex === 0 ? playbackDuration : leftDeckView?.track?.duration ?? 0),
      playing:
        (leftPerformanceState
          ? leftPerformanceState.playing
          : undefined) ??
        (visualActiveIndex === 0 && deckPlaying),
      transportRunning: leftPerformanceState
        ? leftPerformanceState.playing && !leftPerformanceState.buffering
        : visualActiveIndex === 0 && deckPlaying,
      peakLevel: leftPerformanceState?.peakLevel ?? 0,
      rate: leftPerformanceState?.rate ?? 1,
      audibleRate: leftPerformanceState
        ? (Number.isFinite(leftPerformanceState.audibleRate)
          ? leftPerformanceState.audibleRate
          : (leftPerformanceState.playing ? leftPerformanceState.rate : 0))
        : 1,
      scratchHeld: leftPerformanceState?.scratchHeld ?? false,
      discontinuityRevision: leftPerformanceState?.discontinuityRevision ?? 0,
      cover: leftDeckView?.cover ?? "",
      loopStart: leftPerformanceState?.loopStart ?? null,
      loopLength: leftPerformanceState?.loopLength ?? null,
      effectiveLoopStart: leftPerformanceState?.effectiveLoopStart ?? null,
      effectiveLoopLength: leftPerformanceState?.effectiveLoopLength ?? null,
      effectiveLoopGeneration: leftPerformanceState?.effectiveLoopGeneration ?? 0,
    },
    {
      track: rightDeckView?.track ?? null,
      active: visualActiveIndex === 1,
      position: deckTransportSeconds(1, rightDeckView?.track ?? null),
      duration:
        rightPerformanceState?.duration ??
        (visualActiveIndex === 1 ? playbackDuration : rightDeckView?.track?.duration ?? 0),
      playing:
        (rightPerformanceState
          ? rightPerformanceState.playing || rightPerformanceState.desiredPlaying
          : undefined) ??
        (visualActiveIndex === 1 && deckPlaying),
      transportRunning: rightPerformanceState
        ? rightPerformanceState.playing && !rightPerformanceState.buffering
        : visualActiveIndex === 1 && deckPlaying,
      peakLevel: rightPerformanceState?.peakLevel ?? 0,
      rate: rightPerformanceState?.rate ?? 1,
      audibleRate: rightPerformanceState
        ? (Number.isFinite(rightPerformanceState.audibleRate)
          ? rightPerformanceState.audibleRate
          : (rightPerformanceState.playing ? rightPerformanceState.rate : 0))
        : 0,
      scratchHeld: rightPerformanceState?.scratchHeld ?? false,
      discontinuityRevision: rightPerformanceState?.discontinuityRevision ?? 0,
      cover: rightDeckView?.cover ?? "",
      loopStart: rightPerformanceState?.loopStart ?? null,
      loopLength: rightPerformanceState?.loopLength ?? null,
      effectiveLoopStart: rightPerformanceState?.effectiveLoopStart ?? null,
      effectiveLoopLength: rightPerformanceState?.effectiveLoopLength ?? null,
      effectiveLoopGeneration: rightPerformanceState?.effectiveLoopGeneration ?? 0,
    },
  ];
  const performanceDecksRef = useRef(performanceDecks);
  performanceDecksRef.current = performanceDecks;
  const performanceStreamTokens: [string, string] = [
    performanceDecks[0].track && isStreamTrack(performanceDecks[0].track)
      ? streamWaveformToken(performanceDecks[0].track)
      : "",
    performanceDecks[1].track && isStreamTrack(performanceDecks[1].track)
      ? streamWaveformToken(performanceDecks[1].track)
      : "",
  ];
  useEffect(() => {
    const releases = ([0, 1] as const).flatMap((side) => {
      const deckTrack = performanceDecks[side].track;
      const token = performanceStreamTokens[side];
      if (!deckTrack || !isStreamTrack(deckTrack) || !token) return [];
      return [subscribeStreamAnalysisPoll(deckTrack, token, {
        duration: () => {
          const physical = playerRuntime.state().decks[side];
          return physical.trackId === deckTrack.id
            ? physical.duration || deckTrack.duration || 0
            : deckTrack.duration || 0;
        },
        // A mounted but paused Deck still needs its background proxy capture and full analysis.
        ended: () => false,
      })];
    });
    return () => releases.forEach((release) => release());
  }, [
    performanceDecks[0].track?.id,
    performanceDecks[1].track?.id,
    performanceStreamTokens[0],
    performanceStreamTokens[1],
  ]);
  const resetPerformanceControlsForManagerLoad = () => {
    performanceChannelGainsRef.current = [1, 1];
  };

  const focusPerformanceDeck = (side: 0 | 1, deckTrack: Track, at: number) => {
    visualActiveIndexRef.current = side;
    setVisualActiveIndex(side);
    if (trackRef.current?.id !== deckTrack.id) {
      // Hidden Deck preloads must not enter the ordinary single-track load effect a second time.
      djViaRef.current = deckTrack.id;
      trackRef.current = deckTrack;
      setTrack(deckTrack);
      if (usesLocalLibraryRecord(deckTrack)) selectTrack(deckTrack);
    }
    positionRef.current = at;
    setPosition(at);
    setDuration(deckTrack.duration ?? 0);
  };

  eagerManagerLoadRef.current = (next, autoPlay) => {
    // Provider streams still need async URL resolution, mobile owns a different media lifecycle,
    // and dual-Deck loads preserve physical Deck controls. Only the desktop manager's local path
    // can safely construct and submit its source synchronously in the original user gesture.
    if (!desktopNative || !nativePlayer || dualDeck || isStreamTrack(next)) {
      return false;
    }

    resetPerformanceControlsForManagerLoad();
    const applyAutomaticCue = autoInOutCueRef.current === next.id;
    const initialPosition =
      applyAutomaticCue && next.cue_ms != null ? Math.max(0, next.cue_ms / 1_000) : 0;
    autoInOutCueRef.current = null;
    const loadGeneration = ++nativeLoadGenerationRef.current;
    nativeLoadInFlightRef.current = true;
    nativeLoadTargetRef.current = { trackId: next.id, generation: loadGeneration };
    eagerManagerLoadTokenRef.current = { trackId: next.id, generation: loadGeneration };
    const stillCurrent = () => loadGeneration === nativeLoadGenerationRef.current;
    const prepared = {
      src: mediaUrlForTrack(next),
      track: next,
      artworkUrl: playbackArtworkUrl(next),
      position: initialPosition,
      autoplay: autoPlay,
    };

    // The desktop-native owner is authoritative in Tauri. Tear down a stale browser bridge before
    // issuing IPC, but do not wait for React or for any visual panel to mount.
    djEngine.cancel();
    djEngine.hardPause(djEngine.frontElement());
    void nativePlayer
      .load(prepared)
      .then((state) => {
        if (!stillCurrent()) return;
        if (state.status === "error") {
          commitPlaying(false);
          nativeLoadTargetRef.current = null;
          nativeLoadInFlightRef.current = false;
          setNotice(state.error || "原生播放器无法播放这个文件");
          void nativePlayer.pause().catch(() => {});
          return;
        }
        setPosition(state.currentTime);
        setDuration(state.duration || next.duration || 0);
        setNotice("");
      })
      .catch((error: unknown) => {
        if (!stillCurrent()) return;
        nativeLoadTargetRef.current = null;
        nativeLoadInFlightRef.current = false;
        commitPlaying(false);
        void nativePlayer.pause().catch(() => {});
        setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return true;
  };

  const performanceDeckInstallGenerationRef = useRef<[number, number]>([0, 0]);
  const installPerformanceTrack = async (
    side: 0 | 1,
    deckTrack: Track,
    autoplay: boolean,
    requestedPosition?: number,
  ) => {
    const generation = performanceDeckInstallGenerationRef.current[side] + 1;
    const surfaceEpoch = performanceSurfaceEpochRef.current;
    performanceDeckInstallGenerationRef.current[side] = generation;
    const isCurrentPerformanceLoad = () =>
      performanceSurfaceActiveRef.current
      && performanceSurfaceEpochRef.current === surfaceEpoch
      && performanceDeckInstallGenerationRef.current[side] === generation;
    const nativeStateBefore = playerRuntime.state();
    const currentBefore = trackRef.current;
    const currentSideBefore = currentBefore
      ? nativeStateBefore.decks[visualActiveIndexRef.current].trackId === currentBefore.id
        ? visualActiveIndexRef.current
        : nativeStateBefore.decks.findIndex((deck) => deck.trackId === currentBefore.id)
      : -1;
    // A/B are independent physical Decks. Loading the same track on both is intentional for
    // beat jumps, loops and handoffs; track identity must never be used as a uniqueness lock.
    const at = Math.max(0, requestedPosition ?? (deckTrack.first_beat ?? 0));
    // 先把封面标题钉上目标 Deck；YouTube Music 等平台解析直链可能很慢，不能等 ACK。
    setPerformancePendingDecks((current) => {
      const next: [Track | null, Track | null] = [current[0], current[1]];
      next[side] = deckTrack;
      return next;
    });
    setPerformanceDeckOverrides((current) => {
      const next: [Track | null, Track | null] = [current[0], current[1]];
      if ((currentSideBefore === 0 || currentSideBefore === 1) && currentBefore) {
        next[currentSideBefore] = currentBefore;
      }
      next[side] = deckTrack;
      return next;
    });
    if (autoplay || side === visualActiveIndexRef.current) {
      focusPerformanceDeck(side, deckTrack, at);
    }
    try {
      const source = await playbackSourceForTrack(deckTrack, {
        position: at,
        rate: nativeStateBefore.decks[side].trackId === null
          ? 1
          : nativeStateBefore.decks[side].rate,
        autoplay,
      });
      // Resolving an online source may outlive the DJ surface or a newer load on this side. Once
      // manager ownership has returned, never enqueue a late LoadDeck behind its ordinary Load.
      if (!isCurrentPerformanceLoad()) return;
      await playerRuntime.loadDeck(side, source);
      if (!isCurrentPerformanceLoad()) return;
      setRetainedDecks((current) => {
        const next: [Track | null, Track | null] = [current[0], current[1]];
        next[side] = deckTrack;
        return next;
      });
      if (autoplay) {
        transportHandledRef.current = true;
        commitPlaying(true);
      }
      setNotice("");
    } finally {
      if (isCurrentPerformanceLoad()) {
        setPerformancePendingDecks((current) => {
          if (current[side]?.id !== deckTrack.id) return current;
          const next: [Track | null, Track | null] = [current[0], current[1]];
          next[side] = null;
          return next;
        });
      }
    }
  };
  loadPerformanceTrackRef.current = installPerformanceTrack;

  return (
    <div
      className="kd-player"
      data-pip={pipDriving ? "true" : undefined}
    >
      {/* 这里不再渲染 <audio>：播放元素归 djEngine 所有（两台 deck 互换正主），
          事件监听在上面的 effect 里挂到 frontEl 上 */}
      {/* 不再挂隐藏视频实例：详情面板已有可见播放器，双实例会同时解码并
          互相回传 seek，画面就一卡一卡。音频是主时钟，打开详情时再对齐即可。 */}
      <LyricsHost current={track} allowDesktop={!video} />

      <div className="kd-player-leading">
        <PlayerDeck
          side="left"
          view={leftDeckView}
          active={visualActiveIndex === 0}
          spinning={Boolean(leftDeckView) && (transitionShowing || performanceDecks[0].playing)}
          transitioning={transitionShowing}
          resolving={Boolean(
            leftDeckView?.track &&
              (performancePendingDecks[0]?.id === leftDeckView.track.id ||
                (visualActiveIndex === 0 && isUnresolvedStreamTrack(leftDeckView.track))),
          )}
          dropActive={deckDropSide === "left"}
          detailEnabled={!portrait || visualActiveIndex === 0}
          onOpen={() => openDeck(leftDeckView, visualActiveIndex === 0)}
          onDragOver={(event) => deckDragOver(event, "left")}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDeckDropSide(null);
          }}
          onDrop={(event) => void dropOnDeck(event, "left")}
        />
      </div>

      {/* 三颗走带键：上一首 / 播放停止 / 下一首。
          全是裸图标，没有按钮框——一条播放条上摆三个描边方块太吵，
          而且它们本来就在同一组里，靠间距分得开。 */}
      <div className="kd-player-transport">
        <div className="kd-player-transport-side" data-side="left">
          <div className="kd-player-float-tools">
            <button
              type="button"
              className="kd-player-step kd-player-auto-advance"
              aria-label={autoAdvance ? "关闭自动切歌" : "开启自动切歌"}
              aria-pressed={autoAdvance}
              data-on={autoAdvance ? "true" : undefined}
              title={
                mobileNative
                  ? autoAdvance
                    ? "自动切歌：开。曲目结束后继续播放；移动端使用普通切换"
                    : "自动切歌：关。曲目结束后停止"
                  : autoAdvance
                    ? `自动切歌：开。双击、下一首和曲目结束都会使用 ${djBars} 小节过渡`
                    : "自动切歌：关。显式换歌直接切换，曲目结束后停止"
              }
              onClick={toggleAutoAdvance}
            >
              <Blend size={14} />
            </button>
            {canDesktopLyrics ? (
              <button
                type="button"
                className="kd-player-step kd-player-lyricsbtn"
                aria-label={
                  networkPreview
                    ? "B站预览使用浮动小窗"
                    : video
                      ? sharedFloatOn
                        ? "本地视频改用详情播放"
                        : "本地视频改用悬浮小窗播放"
                      : sharedFloatOn
                        ? "关闭悬浮歌词"
                        : "打开悬浮歌词"
                }
                aria-pressed={sharedFloatOn}
                data-on={sharedFloatOn ? "true" : undefined}
                disabled={networkPreview}
                title={
                  networkPreview
                    ? "B站搜索结果固定使用浮动小窗；此设置只影响本地视频"
                    : video
                      ? sharedFloatOn
                        ? "本地视频：浮动小窗。点一下改为详情播放"
                        : "本地视频：详情播放。点一下改为浮动小窗"
                      : sharedFloatOn
                        ? "悬浮歌词：开。点一下关闭"
                        : "打开悬浮歌词"
                }
                onClick={() => {
                  if (networkPreview) return;
                  if (video) cyclePipMode();
                  else void toggleLyricsOverlay();
                }}
              >
                <PictureInPicture2 size={13} />
              </button>
            ) : null}
          </div>
          <label
            className="kd-player-volume"
            title={`音量 ${Math.round(playerVolume * 100)}%（↑↓）`}
            data-muted={playerVolume === 0 ? "true" : undefined}
            style={{ "--kd-volume-fill": `${playerVolume * 100}%` } as CSSProperties}
          >
            <span ref={playerVolumeMeterRef} className="kd-player-volume-leds" aria-hidden="true">
              <span className="kd-player-volume-row" data-slice="previous"><i /></span>
              <span className="kd-player-volume-row" data-slice="current"><i /></span>
            </span>
            <b className="kd-player-volume-thumb" aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={playerVolume}
              aria-label="播放器音量"
              onChange={(event) => setMasterVolume(Number(event.currentTarget.value))}
            />
          </label>
        </div>

        <div className="kd-player-transport-core">
          <button
            type="button"
            className="kd-player-step"
            aria-label="上一首"
            title="上一首"
            disabled={!canGoBack}
            onClick={() => void goPrevious()}
          >
            <SkipBack size={15} fill="currentColor" />
          </button>

        <button
          type="button"
          className="kd-player-go"
          aria-busy={transportLoading ? "true" : undefined}
          aria-label={
            transportLoading
              ? transportLoadingLabel
              : pipDriving && pipSession?.source === "network"
                ? pipPlaying
                  ? "暂停预览"
                  : "播放预览"
                : playing
                  ? "暂停"
                  : "播放"
          }
          data-playing={
            (pipDriving && pipSession?.source === "network" ? pipPlaying : playing) ? "true" : undefined
          }
          data-loading={transportLoading ? "true" : undefined}
          disabled={transportLoading || (!displayTrack && !pipDriving)}
          title={
            transportLoading
              ? `${transportLoadingLabel}，请稍候`
              : pipDriving && pipSession?.source === "network"
                ? "播放 / 暂停预览（空格）"
                : "播放 / 暂停（空格）"
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // 走带键按下就生效，不等 pointerup 后的 click；触摸、鼠标长按时都不会
            // 多拖几十到几百毫秒才停声。
            event.preventDefault();
            transportPointerAtRef.current = performance.now();
            toggleTransport();
          }}
          onPointerUp={() => {
            // 长按后松手，合成 click 才到；把手势时刻刷到松手点，窗口判断不受按住时长影响。
            if (transportPointerAtRef.current) transportPointerAtRef.current = performance.now();
          }}
          onClick={() => {
            // 指针手势已在 pointerdown 切换过一次；紧跟其后的 click（含 Android WebView
            // 无视 preventDefault 合成的那次）一律吞掉。键盘激活没有指针手势，正常放行。
            if (performance.now() - transportPointerAtRef.current < 800) return;
            toggleTransport();
          }}
        >
          {transportLoading ? (
            <LoaderCircle className="kd-spin" size={15} aria-hidden="true" />
          ) : (pipDriving && pipSession?.source === "network" ? pipPlaying : playing) ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>

        <button
          type="button"
          className="kd-player-step"
          aria-label="下一首"
          title={mode === "harmonic" ? "下一首（按和声推荐接）" : `下一首（${MODE_UI[mode].label}）`}
          disabled={!currentAdvanceTrack()}
          onClick={() => void goNext()}
        >
          <SkipForward size={15} fill="currentColor" />
        </button>
        </div>

        <div className="kd-player-transport-side" data-side="right">

        {/* 播放模式 + 范围，紧挨走带键：它们改的就是"下一首是谁"。
            各一颗按钮循环切换，图标即状态——模式是四选一（调性/顺序/随机/单曲循环），
            范围是二选一（全库/当前文件夹）。范围复用详情栏「接歌范围」那个开关，
            两处拨的是同一个值（见 harmonicScope.ts 为什么必须如此）。 */}
        <button
          type="button"
          className="kd-player-step kd-player-mode"
          aria-label={`播放模式：${MODE_UI[mode].label}`}
          title={`${MODE_UI[mode].label}：${MODE_UI[mode].hint}。点一下换下一种`}
          onClick={cycleMode}
        >
          {(() => {
            const Icon = MODE_UI[mode].icon;
            return <Icon size={14} />;
          })()}
        </button>
        {canDownloadStreamTrack(track) ? (
          <button
            type="button"
            className="kd-player-step kd-player-stream-download"
            disabled={enqueueBusy}
            aria-label={enqueueBusy ? "正在创建下载任务" : "下载当前在线歌曲"}
            title={enqueueBusy ? "正在创建下载任务…" : "下载当前在线歌曲"}
            onClick={() => downloadStreamTrack(track)}
          >
            <Download size={14} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="kd-player-step"
            aria-label={
              scope === "folder"
                ? "范围：当前文件夹"
                : "范围：全部曲库"
            }
            title={
              scope === "folder"
                ? "只在当前文件夹里挑下一首。点一下改成全部曲库"
                : "在全部曲库里挑下一首。点一下改成只在当前文件夹里挑"
            }
            onClick={() => setScope(scope === "all" ? "folder" : "all")}
          >
            {scope === "folder" ? (
              <FolderOpen size={14} />
            ) : (
              <Library size={14} />
            )}
          </button>
        )}
        {canRefreshPrediction && (
          <button
            type="button"
            className="kd-player-step kd-player-reroll"
            aria-label="随机换一首候选"
            title="换一首随机候选"
            disabled={refreshingPrediction}
            onClick={() => void refreshPrediction()}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        )}
        {/* 时间属于走带状态，不属于波形本身：放在模式 / 范围两键后，读起来也不必
            从右下角追到波形末端。 */}
        <span
          className="kd-player-time kd-player-time-header"
          aria-label={timeDisplayMode === "elapsed" ? "已播放时间和总时长" : "剩余时间和总时长"}
        >
          {playbackDuration > 0
            ? timeDisplayMode === "elapsed"
              ? `${formatDuration(elapsed)} / ${formatDuration(playbackDuration)}`
              : `−${formatDuration(remaining)} / ${formatDuration(playbackDuration)}`
            : timeDisplayMode === "elapsed" ? "--:-- / --:--" : "−−:−− / −−:−−"}
        </span>
        </div>
      </div>

      <div className="kd-player-trailing">
        <PlayerDeck
          side="right"
          view={rightDeckView}
          active={visualActiveIndex === 1}
          spinning={Boolean(rightDeckView) && (transitionShowing || performanceDecks[1].playing)}
          transitioning={transitionShowing}
          resolving={Boolean(
            rightDeckView?.track &&
              (performancePendingDecks[1]?.id === rightDeckView.track.id ||
                (visualActiveIndex === 1 && isUnresolvedStreamTrack(rightDeckView.track))),
          )}
          dropActive={deckDropSide === "right"}
          detailEnabled={!portrait || visualActiveIndex === 1}
          onOpen={() => openDeck(rightDeckView, visualActiveIndex === 1)}
          onDragOver={(event) => deckDragOver(event, "right")}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDeckDropSide(null);
          }}
          onDrop={(event) => void dropOnDeck(event, "right")}
        />
      </div>

      <div className="kd-player-scrub">
        {/* 本地视频沿用曲库分析波形；网络视频没有音频波形时保留细进度条。
            在线试听则按需解码真实波形，解码未完成时由 Waveform 自己显示进度降级。 */}
        <div className="kd-player-wave-stage">
          {pipDriving && pipSession?.source === "local" ? (
          <Waveform
            className="kd-player-wave"
            renderProfile="release-overview"
            releaseOverviewIntent="player"
            trackId={pipSession.trackId}
            track={track?.id === pipSession.trackId ? track : undefined}
            position={pipPosition}
            duration={pipDuration}
            preserveBarPhase={autoBeatSync}
            playing={pipPlaying}
            playbackRate={1}
            cueMs={
              track?.id === pipSession.trackId
                ? selected?.id === track.id
                  ? selected.cue_ms
                  : track.cue_ms
                : null
            }
            endMs={
              track?.id === pipSession.trackId
                ? selected?.id === track.id
                  ? selected.end_ms
                  : track.end_ms
                : null
            }
            height={42}
            dimPlayed
            onSetPoint={
              track?.id === pipSession.trackId
                ? async (kind, at) => {
                    const cueMs = selected?.id === track.id ? selected.cue_ms : track.cue_ms;
                    const endMs = selected?.id === track.id ? selected.end_ms : track.end_ms;
                    const patch = pointPatch(kind, at, cueMs, endMs);
                    if (typeof patch === "string") return patch;
                    const next = await updateTrack(track.id, patch);
                    setTrack(next);
                  }
                : undefined
            }
          />
        ) : pipDriving ? (
          <div
            className="kd-player-wave-stream"
            role="slider"
            aria-label="视频预览进度"
            aria-valuemin={0}
            aria-valuemax={pipDuration}
            aria-valuenow={pipPosition}
            onClick={(event) => {
              if (pipDuration <= 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const at = ((event.clientX - rect.left) / rect.width) * pipDuration;
              seekVideoPip(at);
            }}
          >
            <span
              className="kd-player-wave-stream-fill"
              style={{
                width: `${pipDuration > 0 ? Math.min(100, (pipPosition / pipDuration) * 100) : 0}%`,
              }}
            />
          </div>
        ) : displayTrack && !streaming ? (
          <Waveform
            className="kd-player-wave"
            renderProfile="release-overview"
            releaseOverviewIntent="player"
            trackId={displayTrack.id}
            track={displayTrack}
            position={track?.id === displayTrack.id ? position : 0}
            duration={track?.id === displayTrack.id ? playbackDuration : (displayTrack.duration ?? 0)}
            preserveBarPhase={autoBeatSync && track?.id === displayTrack.id}
            playing={track?.id === displayTrack.id && deckPlaying}
            playbackRate={playbackVisualRate}
            cueMs={selected?.id === displayTrack.id ? selected.cue_ms : displayTrack.cue_ms}
            endMs={selected?.id === displayTrack.id ? selected.end_ms : displayTrack.end_ms}
            cuePoints={displayTrack.cue_points}
            height={42}
            dimPlayed
            onSetPoint={track?.id === displayTrack.id && usesLocalLibraryRecord(track) ? async (kind, at) => {
              const cueMs = selected?.id === track.id ? selected.cue_ms : track.cue_ms;
              const endMs = selected?.id === track.id ? selected.end_ms : track.end_ms;
              const patch = pointPatch(kind, at, cueMs, endMs);
              if (typeof patch === "string") return patch;
              const next = await updateTrack(track.id, patch);
              setTrack(next);
            } : undefined}
          />
        ) : track && streaming ? (
          <Waveform
            className="kd-player-wave"
            renderProfile="release-overview"
            releaseOverviewIntent="player"
            trackId={track.id}
            track={track}
            position={position}
            duration={playbackDuration}
            height={42}
            dimPlayed
            preserveBarPhase={autoBeatSync}
            playing={deckPlaying}
            playbackRate={playbackVisualRate}
            cueMs={track.cue_ms}
            endMs={track.end_ms}
            onSetPoint={(kind, at) => {
              const patch = pointPatch(kind, at, track.cue_ms, track.end_ms);
              if (typeof patch === "string") return patch;
              updateStreamCue(track, patch);
            }}
          />
        ) : (
          <div className="kd-player-wave-idle" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
