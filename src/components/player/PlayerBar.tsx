import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Blend,
  Clapperboard,
  Disc3,
  Download,
  FolderOpen,
  Library,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RefreshCw,
  Shuffle,
  SlidersHorizontal,
  PictureInPicture2,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
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
  DJ_TRANSITIONS,
  bpmSyncRate,
  djEngine,
  findMixStartTime,
  mixSeconds,
  mixStartFromDuration,
  useDjConfig,
} from "../../lib/djMix";
import { BEATS_PER_BAR, msUntilNextBoundary } from "../../lib/beatGridSync";
import { useAppStore } from "../../stores/appStore";
import { useCrossfade, deckGain } from "../../lib/crossfade";
import { useHarmonicScope } from "../../lib/harmonicScope";
import { useLyricsPrefs } from "../../lib/lyricsPrefs";
import { ensureOverlayPermission } from "../../lib/lyricsOverlay";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import {
  isDualDeckSession,
  shouldDriveGlobalTransport,
  shouldReconcileSingleTrackOwner,
  type WorkMode,
} from "../../lib/workMode";
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
  mediaUrlForTrack,
  preloadStreamTrack,
  publishStreamTrack,
  publishStreamTrackState,
  resolvePendingStreamTrack,
  streamCoverUrl,
  streamMeta,
  streamNextTrack,
  streamWaveformToken,
} from "../../lib/streamTrack";
import { playSongPreview } from "../../lib/songPreview";
import { useDownloadStore } from "../../stores/downloadStore";
import {
  requestLocalVideo,
  seekVideoPip,
  toggleVideoPip,
  useVideoPip,
} from "../../lib/videoPip";
import type { CuePoint, StemModelStatus, StemName, Track, TrackStemStatus } from "../../types";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import { POSITION_EVENT, type PositionDetail } from "../library/TrackDetail";
import { PLAY_EVENT, parsePlayRequest, playTrack } from "../../lib/playTrack";
import { getPlayingTrack, setPlayingTrack } from "../../lib/playingTrack";
import { usePlayerShortcuts } from "../../lib/usePlayerShortcuts";
import { recordStreamAnalysisProgress } from "../../lib/streamAnalysis";
import {
  mergeCachedStreamWaveform,
  loadWaveformForTrack,
  mediaBufferedRanges,
  prefetchWaveform,
  updateStreamWaveform,
} from "../../lib/waveformCache";
import {
  isOneLibraryPlaybackTrack,
  oneLibraryPlaybackSource,
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
import { finishTrackDrop, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { runtimePlayer, usesNativeMobilePlayer } from "../../lib/unifiedPlayer";
import { decideNativeLatestIntent, LatestIntentGate } from "../../lib/latestIntentGate";
import { LyricsHost } from "./LyricsHost";
import {
  PerformanceWorkspace,
  type PerformanceDeckModel,
  type PerformanceStemDeckModel,
} from "./PerformanceWorkspace";
import { eqBandDb, nextLoadedDeckIndex, performanceLoadDeckIndex } from "../../lib/performanceCues";
import { clampStemGain, stemGainRequestReady } from "../../lib/stemEq";
import { allStemMask as stemMaskForMode } from "../../lib/stemMode";
import {
  beginMidiScratchHold,
  canResumeMidiScratchHold,
  type MidiScratchHold,
} from "../../lib/midiScratchHold";
import { writeLocalStorageSoon } from "../../lib/storageWrite";

/** 广播播放位置的节流间隔：节拍网格的播放头不需要每帧更新。 */
const POSITION_BROADCAST_MS = 200;
/** 在线波形前台约 15fps；窗口后台只保留 4fps 的真实 analyser 采样。 */
const STREAM_WAVEFORM_FOREGROUND_MS = 66;
const STREAM_WAVEFORM_BACKGROUND_MS = 250;
/** 后端缓存波形只在当前在线曲目上短轮询；它不触发第二个媒体下载。 */
const STREAM_CACHE_WAVEFORM_POLL_MS = 750;
/** 缓存尚未预约/暂时失败时保持低频观察；切歌或媒体结束后自然收掉。 */
const STREAM_CACHE_WAVEFORM_IDLE_POLL_MS = 3_000;
/** macOS/Windows 可能同时从原生媒体会话和 WebView 报告同一次媒体键。 */
const SYSTEM_MEDIA_DEDUPE_MS = 180;

function stemBit(stem: StemName): number {
  return stem === "drums" ? 1 : stem === "bass" ? 2 : stem === "other" ? 4 : 8;
}

function sameStemStatus(left: TrackStemStatus | null, right: TrackStemStatus): boolean {
  return Boolean(
    left
      && left.trackId === right.trackId
      && left.state === right.state
      && left.progress === right.progress
      && left.cachePath === right.cachePath
      && left.duration === right.duration
      && left.error === right.error
      && left.phase === right.phase
      && left.coveredSeconds === right.coveredSeconds
      && left.windowCoveredSeconds === right.windowCoveredSeconds
      && left.waitingForDeck === right.waitingForDeck,
  );
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
}

function readPlayerDeckMemory(): PlayerDeckMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYER_DECK_MEMORY_KEY) ?? "null") as Partial<PlayerDeckMemory> | null;
    return {
      leftId: typeof raw?.leftId === "number" ? raw.leftId : null,
      rightId: typeof raw?.rightId === "number" ? raw.rightId : null,
      activeIndex: raw?.activeIndex === 1 ? 1 : 0,
    };
  } catch {
    return { leftId: null, rightId: null, activeIndex: 0 };
  }
}

function playbackCoverUrl(track: Track): string {
  if (isStreamTrack(track)) return streamCoverUrl(track);
  const source = oneLibraryPlaybackSource(track);
  if (source) {
    return api.oneLibraryCoverUrl(source.devicePath, source.contentId, track.modified_at);
  }
  return usesLocalLibraryRecord(track) ? api.coverUrl(track.id, track.modified_at) : "";
}

function viewForTrack(track: Track): PlayerDeckView {
  const streaming = isStreamTrack(track);
  return {
    key: `${streaming ? "stream" : isOneLibraryPlaybackTrack(track) ? "onelibrary" : "library"}:${track.id}`,
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
  onOpen(): void;
  onDragOver(event: React.DragEvent<HTMLElement>): void;
  onDragLeave(event: React.DragEvent<HTMLElement>): void;
  onDrop(event: React.DragEvent<HTMLElement>): void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [view?.key]);
  // 接歌途中也只保留这两个身份；真正交接完成后，父组件才交换 active。
  const stateLabel = active ? "正在播放" : "下一首";
  return (
    <div
      className="kd-player-deck"
      data-side={side}
      data-active={active ? "true" : undefined}
      data-transitioning={transitioning ? "true" : undefined}
      data-empty={!view ? "true" : undefined}
      data-drop-active={dropActive ? "true" : undefined}
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

interface PlayerBarProps {
  workMode: WorkMode;
  djWorkspaceHost: HTMLDivElement | null;
}

export function PlayerBar({ workMode, djWorkspaceHost }: PlayerBarProps) {
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
  const djConfigured = useDjConfig((state) => state.enabled);
  // 手机仍由系统连续播放服务持有输出；实时双 Deck 只在共享 Rust 桌面引擎和
  // 浏览器预览 adapter 中开放，不能亮着 DJ 灯却在移动端偷偷退化成硬切。
  const djEnabled = djConfigured && !mobileNative;
  const djTransitions = useDjConfig((state) => state.transitions);
  const djBars = useDjConfig((state) => state.bars);
  const applyInOutPoints = useDjConfig((state) => state.applyInOutPoints);
  const autoBeatSync = useDjConfig((state) => state.autoBeatSync);
  const toggleDjEnabled = useDjConfig((state) => state.toggleEnabled);
  const transportFade = usePlaybackPrefs((state) => state.transportFade);
  const focusLibrary = useAppStore((state) => state.focusLibrary);
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);
  const defaultQuality = useAppStore((state) => state.settings?.default_quality ?? null);
  const filterResonance = useAppStore((state) => state.settings?.filter_resonance ?? "high");
  const stemMode = useAppStore((state) => state.settings?.stem_mode ?? "none");
  const stemCompute = useAppStore((state) => state.settings?.stem_compute ?? "auto");
  const desiredStemRuntimeKey = `${stemMode}:${stemCompute}`;
  const allStemMask = stemMaskForMode(stemMode);
  const enqueueDownload = useDownloadStore((state) => state.enqueue);
  const [enqueueBusy, setEnqueueBusy] = useState(false);
  const desktopLyricsOn = useLyricsPrefs((state) => state.desktopEnabled);
  const setDesktopLyricsOn = useLyricsPrefs((state) => state.setDesktopEnabled);
  const canDesktopLyrics = Boolean(window.kdj?.desktopLyrics);
  const pipMode = useVideoPip((state) => state.mode);
  const pipActive = useVideoPip((state) => state.active);
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
  const [track, setTrack] = useState<Track | null>(() => getPlayingTrack());
  const activeStreamWaveformToken =
    track && isStreamTrack(track) ? streamWaveformToken(track) : "";
  /** 纯浏览器开发预览仍由 Web Audio 双 Deck 持有；正式 Tauri 壳不再切换 owner。 */
  const [browserDjSession, setBrowserDjSession] = useState(
    () => playerRuntime.kind === "browser-preview" && isStreamTrack(track),
  );
  // 桌面与 Android 的本地/在线音频始终由同一个 Rust coordinator 持有。跨
  // Rust→WebAudio 接管曾同时造成交接爆音、在线 seek 冷启动和渐变 transport 分叉。
  const nativePlayer = playerRuntime.kind === "browser-preview" ? null : playerRuntime;
  const [playing, setPlaying] = useState(false);
  const [performanceDeckStates, setPerformanceDeckStates] = useState(
    () => playerRuntime.state().decks,
  );
  const [performanceStems, setPerformanceStems] = useState<[
    PerformanceStemDeckModel,
    PerformanceStemDeckModel,
  ]>([
    { status: null, enabled: false, mask: allStemMask, gains: [1, 1, 1, 1] },
    { status: null, enabled: false, mask: allStemMask, gains: [1, 1, 1, 1] },
  ]);
  const [performanceStemModel, setPerformanceStemModel] = useState<StemModelStatus | null>(null);
  const [stemRuntimeReadyKey, setStemRuntimeReadyKey] = useState<string | null>(null);
  const reportedStemModelErrorRef = useRef("");
  const reportedStemTrackErrorsRef = useRef<[string, string]>(["", ""]);
  const pendingStemActionRef = useRef<[
    StemName | "all" | null,
    StemName | "all" | null,
  ]>([null, null]);
  const pendingStemGainTrackRef = useRef<[number | null, number | null]>([null, null]);
  const stemDeckTrackIdsRef = useRef<[number | null, number | null]>([null, null]);
  /** Loop 只能走原曲切片；开着时保留原曲，直到用户明确退出 Loop 或重新启用 STEM。 */
  const loopHoldsOriginalRef = useRef<[boolean, boolean]>([false, false]);
  const [playerVolume, setPlayerVolume] = useState(() => {
    const raw = localStorage.getItem("kd-player-volume");
    if (raw === null) return 1;
    const saved = Number(raw);
    return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  });
  const playerVolumeRef = useRef(playerVolume);
  /** 点喇叭静音前记住的音量；取消静音时还原，而不是硬回到 100%。 */
  const volumeBeforeMuteRef = useRef(playerVolume > 0 ? playerVolume : 1);
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
    if (volume > 0) volumeBeforeMuteRef.current = volume;
    setPlayerVolume(volume);
    const effective = volume * deckGain(useCrossfade.getState().coplay, useCrossfade.getState().x);
    if (nativePlayer) void nativePlayer.setVolume(effective);
    else djEngine.setVolume(effective);
  }, [nativePlayer]);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(() => track?.duration ?? 0);
  const [predicted, setPredicted] = useState<Track | null>(null);
  const [refreshingPrediction, setRefreshingPrediction] = useState(false);
  /** 只在首次恢复会话唱盘时用 localStorage 里的另一台；改范围/模式后必须重新预测。 */
  const useRetainedNextOnceRef = useRef(true);
  const deckMemoryRef = useRef<PlayerDeckMemory>(readPlayerDeckMemory());
  const [retainedDecks, setRetainedDecks] = useState<[Track | null, Track | null]>([null, null]);
  /** 明确拖到 A/B 的曲目固定在指定唱盘；预测逻辑不能把它下一帧覆盖。 */
  const [performanceDeckOverrides, setPerformanceDeckOverrides] = useState<[
    Track | null,
    Track | null,
  ]>([null, null]);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const dualDeck = isDualDeckSession(workMode, performanceOpen);
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
  /** A tempo drag can arrive while a Deck is still being installed. One source load per physical
   * side is enough; every later tempo value waits on it and then collapses through the native
   * latest-value lane instead of queuing duplicate loadDeck IPC calls. */
  const performanceDeckEnsureRef = useRef<[
    { trackId: number; promise: Promise<void> } | null,
    { trackId: number; promise: Promise<void> } | null,
  ]>([null, null]);
  const performanceDeckEnsureGenerationRef = useRef<[number, number]>([0, 0]);
  /** Capacitive platter holds are scoped to the installed source and invalidated by a re-touch. */
  const midiScratchGenerationRef = useRef<[number, number]>([0, 0]);
  const midiScratchHoldsRef = useRef<[MidiScratchHold | null, MidiScratchHold | null]>([null, null]);
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

  // 当前正主和预测出来的下一台 Deck 都提前读波形。真正接歌时只画 canvas，
  // 不在切换临界点再发整轨波形请求。
  useEffect(() => {
    prefetchWaveform(track);
    prefetchWaveform(predicted);
    // 先把在线后继的 provider 直链解析掉；真正把 cue 位置装进浏览器备用 Deck
    // 由下方 prepareNext effect 负责，二者缺一都会把网络等待暴露在交接临界点。
    const next = track && isStreamTrack(track) ? streamNextTrack(track) : null;
    if (next) void preloadStreamTrack(next).catch(() => {});
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
    // 独立桌面歌词 WebView 不共享主窗状态；在线试听和 OneLibrary 都是负数播放 id，
    // 两者都要显式发布完整曲目快照。
    publishStreamTrack(track && track.id < 0 ? track : null);
    setBrowserMediaStatus(track && isStreamTrack(track) ? "loading" : "idle");
  }, [track]);

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
    (restored: Track, restoredIndex: 0 | 1) => {
      if (trackRef.current) return;
      trackRef.current = restored;
      positionRef.current = 0;
      durationRef.current = restored.duration ?? 0;
      visualActiveIndexRef.current = restoredIndex;
      setVisualActiveIndex(restoredIndex);
      setTrack(restored);
      setPosition(0);
      setDuration(restored.duration ?? 0);
      commitPlaying(false);
      if (usesLocalLibraryRecord(restored)) selectTrack(restored);
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
        restorePausedTrack(
          restored,
          active ? memory.activeIndex : memory.activeIndex === 0 ? 1 : 0,
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
      const outgoingIndex = visualActiveIndexRef.current;
      const intent = playbackIntentRef.current;
      const stillCurrent = () =>
        playbackIntentRef.current === intent && trackRef.current?.id === from.id;

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
        const rate = bpmSyncRate(effectiveFromBpm, next.bpm);
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
              rate,
              autoplay: true,
            })
            .then((state) => {
              // load 被更新的播放意图作废时会以 no-op 成功返回；不能让这个旧
              // fallback 继续提交 UI，把用户刚点的新曲目切回去。
              if (!stillCurrent()) return;
              if (state.status === "error") {
                throw new Error(state.error || "原生播放器无法播放这个文件");
              }
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
            if (isStreamTrack(next)) await resolvePendingStreamTrack(next);
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
              const waitMs = msUntilNextBoundary(
                nativePlayer.state().currentTime,
                from.bpm,
                from.first_beat,
                nativePlayer.state().rate || currentRate,
                BEATS_PER_BAR,
              );
              if (waitMs != null) {
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
        if (isStreamTrack(next)) await resolvePendingStreamTrack(next);
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
      if (!dualDeck) setPerformanceDeckOverrides([null, null]);
      const oneLibraryNext = isOneLibraryPlaybackTrack(next);
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
      // 本地视频的 LOCAL_VIDEO 已在 playTrack 发出；这里只补面板档的详情栏。
      // 音频：playTrack 已 clear 预览会话；非流媒体仍进曲库详情。
      if (isLocalVideo) {
        if (useVideoPip.getState().mode === "panel" && !isStreamTrack(next)) {
          window.dispatchEvent(new Event(DETAIL_EVENT));
        }
      } else if (!isStreamTrack(next) && !oneLibraryNext) {
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
      const current = trackRef.current;
      const wantsDjTransition =
        autoPlay &&
        current &&
        playingRef.current &&
        next.id !== current.id;
      if (wantsDjTransition) {
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
      // 同一用户手势里的后续 transport/seek 读 ref；不能等下一轮 effect 才同步，
      // 否则启动恢复请求恰好在这两帧间返回时会把旧唱盘抢回来。
      trackRef.current = next;
      setTrack(next);
      // 右侧详情跟着切到正在放的这首。自动续播接下一首时尤其重要——
      // 不跟的话详情栏还停在上一首，用户看着 A 的 BPM 听着 B
      if (usesLocalLibraryRecord(next)) selectTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      commitPlaying(autoPlay);
      // 手动点播的也记进"放过了"：不然自动续播会把用户刚听完的那首再接一遍
      if (autoPlay) markPlayed(next.id);
    };
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, [selectTrack, focusLibrary, djSwitchTo, commitPlaying, invalidateNativeSeek, nativePlayer, dualDeck]);

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

  // 起手点：有结束点 → 从结束点倒推 N 小节；否则波形找真实尾音，再不行按时长倒推。
  // 在线试听也走同一条逻辑：波形是后台懒加载的，没赶上时先按媒体时长兜底。
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
    let alive = true;
    if (isStreamTrack(track)) {
      djOutroRef.current = {
        trackId: track.id,
        at: mixStartFromDuration(track.duration ?? 0, track.bpm, djBars),
      };
      return;
    }
    const waveform = loadWaveformForTrack(track);
    waveform
      .then((wave) => {
        if (!alive) return;
        const at =
          findMixStartTime(wave, lead) ??
          mixStartFromDuration(wave.duration, track.bpm, djBars);
        djOutroRef.current = { trackId: track.id, at };
      })
      .catch(() => {
        if (!alive) return;
        djOutroRef.current = {
          trackId: track.id,
          at: mixStartFromDuration(track.duration ?? 0, track.bpm, djBars),
        };
      });
    return () => {
      alive = false;
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
    // DJ prepare/handoff 已把曲目装进第二台 Rust/Web Audio Deck；不能让换曲 effect
    // 再执行一次普通 load，把正在进行的 sample-clock 过渡重置掉。
    if (djViaRef.current === track.id) {
      djViaRef.current = null;
      setNotice("");
      return;
    }
    if (nativePlayer) {
      if (desktopNative) {
        djEngine.cancel();
        djEngine.hardPause(djEngine.frontElement());
      }
      const source = mediaUrlForTrack(track);
      const applyAutomaticCue = autoInOutCueRef.current === track.id;
      const initialPosition =
        applyAutomaticCue && track.cue_ms != null ? Math.max(0, track.cue_ms / 1000) : 0;
      autoInOutCueRef.current = null;
      const loadGeneration = ++nativeLoadGenerationRef.current;
      nativeLoadInFlightRef.current = true;
      // A cancelled native→WebAudio bridge may already have queued setVolume(0). Every new
      // native load therefore reasserts the user-visible volume before it installs/plays media;
      // DesktopPlayer serializes these commands, so a late old mute cannot strand this new song
      // at zero gain.
      void nativePlayer.setVolume(playerVolumeRef.current).catch(() => {});
      void nativePlayer
        .load({
          src: source,
          track,
          position: initialPosition,
          autoplay: playingRef.current,
          artworkUrl: playbackCoverUrl(track),
        })
        .then((state) => {
          if (loadGeneration !== nativeLoadGenerationRef.current) return;
          if (state.status === "error") {
            commitPlaying(false);
            setNotice(state.error || "原生播放器无法播放这个文件");
            return;
          }
          setPosition(state.currentTime);
          setDuration(state.duration || track.duration || 0);
          setNotice("");
        })
        .catch((error: unknown) => {
          if (loadGeneration !== nativeLoadGenerationRef.current) return;
          commitPlaying(false);
          setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          if (loadGeneration === nativeLoadGenerationRef.current) {
            nativeLoadInFlightRef.current = false;
          }
        });
      return;
    }
    nativeLoadGenerationRef.current += 1;
    nativeLoadInFlightRef.current = false;
    if (desktopNative) void playerRuntime.pause();
    // 硬切歌（双击列表、回上一首）顺手掐掉可能还在进行的过渡：
    // 不掐的话暗处退场那台 deck 还会再响好几秒
    djEngine.releaseDecodedPlayback();
    djEngine.cancel();
    // cancel 可能刚把尚在准备的 shadow deck 定为目标正主，不能继续使用旧闭包里的元素。
    const audio = djEngine.frontElement();
    setFrontEl(audio);
    const source = mediaUrlForTrack(track);
    // 在线渐进波形从共享 AnalyserNode 取样；先接好音频图，但不预取 shadow、
    // 不整轨解码。此时媒体尚未起播，不会在重接输出时产生爆音。
    if (isStreamTrack(track)) djEngine.warmup();
    audio.src = source;
    audio.load();
    // 自动续播且开关开着：硬切后落到开始点，别从头放前奏。
    if (autoInOutCueRef.current === track.id) {
      autoInOutCueRef.current = null;
      const cueSec = track.cue_ms != null ? track.cue_ms / 1000 : null;
      if (cueSec != null && cueSec > 0) {
        const applyCue = () => {
          try {
            audio.currentTime = cueSec;
          } catch {
            /* metadata 未到时忽略，seeked/canplay 还会再试 */
          }
          setPosition(cueSec);
        };
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) applyCue();
        else audio.addEventListener("loadedmetadata", applyCue, { once: true });
      }
    } else {
      autoInOutCueRef.current = null;
    }
    // shadow 只作解码尚未完成时的回退；正常路径后台准备当前曲目的受限 PCM。
    // 在线流由媒体元素自己的分段缓存负责。若在这里再准备 shadow + 整轨 PCM，
    // 一次试听会出现两到三份并行请求；本地文件才需要无缝 seek 的整轨解码。
    if (!isStreamTrack(track)) {
      djEngine.prepareSeek(source);
      djEngine.prepareDecodedSeek(track, source);
    }
    setNotice("");
    // 播放只交给下面监听 playing/track 的 effect。这里再 play 一次会在暂停后
    // 双击换曲时形成 load → play → play 竞态，其中一个 AbortError 又把状态停掉。
    // playing 不进依赖：它变化时由下面的 effect 处理，这里只管换曲。
    // frontEl 也不进：它只在 DJ 接歌互换时变，而那条路在上面已经 return 了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, nativePlayer, desktopNative, playerRuntime, commitPlaying]);

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

  useEffect(() => {
    if (!track) return;
    if (nativePlayer) {
      if (!shouldDriveGlobalTransport(workMode, performanceOpen)) {
        // Performance buttons already emitted an explicit A/B command. Replaying the manager's
        // global transport here would target the coordinator's previous `front` Deck and start
        // the opposite side whenever focus/track display changes.
        transportHandledRef.current = false;
        return;
      }
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
  }, [playing, track, frontEl, nativePlayer, commitPlaying, transportFade, workMode, performanceOpen]);

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
        if (!shouldCommitSeek(track.id, at)) return;
        if (nativePlayer) {
          requestNativeSeek(track.id, at);
        } else {
          void djEngine
            .seamlessSeek(mediaUrlForTrack(track), at, playingRef.current)
            .then(setFrontEl);
        }
        setPosition(at);
        broadcastMediaSync({
          owner: "player",
          action: "seek",
          trackId: track.id,
          position: at,
        });
      }
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onMediaSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onMediaSync);
  }, [frontEl, track?.id, nativePlayer, commitPlaying, requestNativeSeek, shouldCommitSeek]);

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

  // 不做音量控制：这里只是预听，音量交给系统。软件里再放一个滑块只是多一个要照看的东西。

  // ……推子除外：协同播放时预览面板那把交叉推子按等功率曲线分走一部分音量，
  // 协同一关立刻回满。这不是「音量设置」，是混音动作，值也从不落盘。
  useEffect(() => {
    playerVolumeRef.current = playerVolume;
    writeLocalStorageSoon("kd-player-volume", String(playerVolume), 1_000);
    if (playerVolume > 0) volumeBeforeMuteRef.current = playerVolume;
    // 用户音量与协同交叉推子相乘；移动端直接落到系统 player，桌面两台 deck
    // 一起设，接歌中途也保持一致。
    const effective = playerVolume * deckGain(coplay, fadeX);
    if (nativePlayer) void nativePlayer.setVolume(effective);
    else djEngine.setVolume(effective);
  }, [playerVolume, coplay, fadeX, nativePlayer]);

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
      // 不能只改 React 状态再等 effect：网络视频会在同一个点击栈里立刻 play,
      // 此时原生 CPAL 唱盘尚未收到暂停，WebKit 可能卡在起播阶段。这里同步发出
      // 真实 transport 暂停，并让随后的 effect 只负责对账。
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
          if (isStreamTrack(next)) {
            void resolvePendingStreamTrack(next)
              .then((ready) => {
                if (stillCurrent()) playTrack(ready);
              })
              .catch(() => {
                if (stillCurrent()) commitPlaying(false);
              });
          } else if (stillCurrent()) {
            playTrack(next);
          }
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
            state.status === "error"
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
        shouldReconcileSingleTrackOwner(workMode, performanceOpen) &&
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
        const retrySource =
          current && isStreamTrack(current) && playingRef.current
            ? claimStreamCacheRetry(current)
            : null;
        commitPlaying(false);
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
    workMode,
    performanceOpen,
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
        if (!next || next.id === current.id) {
          djGaveUpRef.current = current.id;
          return true;
        }
        if (!djSwitchTo(next, current)) {
          if (useDjConfig.getState().applyInOutPoints && !isStreamTrack(next)) {
            autoInOutCueRef.current = next.id;
          }
          if (isStreamTrack(next)) {
            void resolvePendingStreamTrack(next)
              .then((ready) => {
                if (stillCurrent()) playTrack(ready);
              })
              .catch(() => {
                if (stillCurrent()) commitPlaying(false);
              });
          } else if (stillCurrent()) {
            if (manual && manualNextDispatchingRef.current && nativePlayer) {
              manualNextTargetRef.current = next.id;
            }
            playTrack(next);
          }
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
    if (djEnabled && (await djNext(true))) return;
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
    if (isStreamTrack(next)) {
      try {
        playTrack(await resolvePendingStreamTrack(next));
      } catch {
        if (
          playbackIntentRef.current === intent &&
          (trackRef.current?.id ?? currentAdvanceTrackRef.current?.id) === current.id
        ) {
          setNotice("下一首在线试听地址解析失败");
        }
      }
    } else {
      if (manualNextDispatchingRef.current && nativePlayer) {
        manualNextTargetRef.current = next.id;
      }
      playTrack(next);
    }
  };

  canRunManualNextRef.current = () => {
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
    if (pip.active && pip.session?.source === "network") {
      toggleVideoPip();
      return;
    }
    // 暂停/恢复也是用户意图：暂停期间完成的异步接播不能把声音擅自拉回来。
    manualNextGateRef.current?.cancel();
    manualNextTargetRef.current = null;
    nativeManualChainDepthRef.current = 0;
    playbackIntentRef.current += 1;
    nativeDjGenerationRef.current += 1;
    nativeDjBusyRef.current = false;
    if (!playingRef.current && !nativePlayer) djEngine.resume();
    if (!trackRef.current) {
      // 重启后 track 尚未装载，但底栏已经恢复了上次正主唱盘；首按应直接
      // 播放眼前这首，而不是要求用户先回曲库重新选中一次。
      const pick = retainedDecks[visualActiveIndex] ?? selectedRef.current;
      if (pick) playTrack(pick);
      return;
    }
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
      const currentlyPlaying =
        pip.active && pip.session?.source === "network" ? pip.playing : playingRef.current;
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
    if (pip.active && pip.session?.source === "network") {
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

  // 代理实际送到播放器的连续字节写到哪，就从同一份短生命周期前缀解码到哪；若
  // 用户开启持久缓存则直接复用它的临时文件。浏览器的 buffered 只能提供时间范围，
  // 不能读未来 PCM，因此这里只轮询 token 作用域的本地快照，绝不再 fetch 原始音频。
  // 旧后端尚未支持此端点时继续走上面的 analyser 已播路径，声音和进度条不受影响。
  useEffect(() => {
    if (!track || !isStreamTrack(track) || !activeStreamWaveformToken) return;
    const audio = frontEl;
    const trackId = track.id;
    const token = activeStreamWaveformToken;
    let disposed = false;
    let timer = 0;
    let lastRevision = -1;

    const totalDuration = () => {
      const mediaDuration = audio.duration;
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
      return durationRef.current || track.duration || 0;
    };
    const schedule = (delay: number) => {
      if (!disposed) timer = window.setTimeout(poll, delay);
    };
    const poll = () => {
      void api
        .songPreviewWaveform(token)
        .then((progress) => {
          if (disposed) return;
          // 完整流媒体分析复用这条既有 token 轮询；右侧详情订阅本地快照，
          // 不会为了 BPM/调号再开一条定时器或再请求音频。
          recordStreamAnalysisProgress(trackId, progress);
          if (progress.waveform && progress.revision > lastRevision) {
            const total = totalDuration();
            // `covered_seconds` 是 prefix 的真实 PCM 时长；merge 函数会只投影到
            // 这段对应的整曲桶，绝不会把前缀波形拉伸成全曲。
            const covered = Math.min(total, Math.max(0, progress.covered_seconds));
            mergeCachedStreamWaveform(
              trackId,
              total,
              progress.covered_seconds,
              progress.waveform,
              progress.revision,
              covered > 0 ? [{ start: 0, end: covered }] : [],
            );
            lastRevision = progress.revision;
          }
          // 缓存预约可能晚于首个媒体 GET 很久（弱网、重试、短暂服务忙）；不能因
          // 固定 4 秒窗口提前放弃。空闲时退到低频，仍只在当前曲目且尚未结束时续租。
          if (
            progress.enabled &&
            !(progress.complete && !progress.active) &&
            !((nativePlayer ? nativePlayer.state().status === "ended" : audio.ended) && !progress.active)
          ) {
            schedule(
              progress.active
                ? STREAM_CACHE_WAVEFORM_POLL_MS
                : STREAM_CACHE_WAVEFORM_IDLE_POLL_MS,
            );
          }
        })
        .catch(() => {
          // 波形是纯展示；票据过期、旧后端 404 或缓存服务短暂不可达都不能让
          // 当前试听变成报错。上面的 analyser 仍会继续填已播部分。
        });
    };
    poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
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
    !(pipSession?.source === "local" && pipMode === "panel");
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
    void previewNext(base).then((next) => {
      if (!alive || predictionEpochRef.current !== epoch) return;
      predictedRef.current = next;
      predictedPolicyRef.current = next ? generatedPolicy : null;
      setPredicted(next);
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
      if (isStreamTrack(predicted)) await resolvePendingStreamTrack(predicted);
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
    djTransitions,
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
    const rate = djEnabled ? bpmSyncRate(effectiveFromBpm, predicted.bpm) : 1;
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
      if (isStreamTrack(predicted)) await resolvePendingStreamTrack(predicted);
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
  ]);

  const transitionShowing = djTransition.phase !== "idle" && transitionVisual !== null;
  const predictedDeckView = predicted ? viewForTrack(predicted) : null;
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
    // Performance 只展示物理 side 上已经确认的正主或用户明确装入的曲目。
    // retainedDecks 可能来自旧的推荐预热；拿它填空会让 UI 标成 B、声音却来自
    // 另一首物理 B，随后按播放键时看起来就像 Deck 被后台偷偷替换。
    const physicalCurrentTrackId = currentDeckView?.track?.id ?? null;
    const physicalCurrentSide = physicalCurrentTrackId !== null
      ? performanceDeckStates.findIndex((deck) => deck.trackId === physicalCurrentTrackId)
      : -1;
    const preparedTrackId = playerRuntime.state().preparedTrackId;
    const retainedLeft = retainedDecks[0]
      && retainedDecks[0].id === performanceDeckStates[0].trackId
      && retainedDecks[0].id !== preparedTrackId ? retainedDecks[0] : null;
    const retainedRight = retainedDecks[1]
      && retainedDecks[1].id === performanceDeckStates[1].trackId
      && retainedDecks[1].id !== preparedTrackId ? retainedDecks[1] : null;
    // Overrides only describe a row while the coordinator confirms that same track on the
    // matching physical Deck. A prior manual load can otherwise survive a later hard load and
    // leave row 1 showing Deck B's audible track as if it still lived on Deck A; every row-local
    // EQ command would then correctly modify a silent Deck and appear completely ineffective.
    const confirmedLeftOverride = performanceDeckOverrides[0]?.id === performanceDeckStates[0].trackId
      ? performanceDeckOverrides[0]
      : null;
    const confirmedRightOverride = performanceDeckOverrides[1]?.id === performanceDeckStates[1].trackId
      ? performanceDeckOverrides[1]
      : null;
    const leftTrack = confirmedLeftOverride
      ?? (physicalCurrentSide === 0 ? currentDeckView?.track ?? null : retainedLeft);
    const rightTrack = confirmedRightOverride
      ?? (physicalCurrentSide === 1 ? currentDeckView?.track ?? null : retainedRight);
    leftDeckView = leftTrack ? viewForTrack(leftTrack) : null;
    rightDeckView = rightTrack && rightTrack.id !== leftTrack?.id ? viewForTrack(rightTrack) : null;
  }
  const deckPlaying = pipDriving && pipSession?.source === "network" ? pipPlaying : playing;
  const playbackPosition = pipDriving ? pipPosition : position;
  // 音频元数据尚未加载（例如恢复上次的唱盘）时，曲库已有的时长仍应先显示；
  // 否则波形都在却只剩一串 --:--，看不出整首还有多久。
  const playbackDuration = pipDriving ? pipDuration : duration || displayTrack?.duration || 0;
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
    const memory: PlayerDeckMemory = { leftId, rightId, activeIndex: visualActiveIndex };
    deckMemoryRef.current = memory;
    localStorage.setItem(PLAYER_DECK_MEMORY_KEY, JSON.stringify(memory));
  }, [
    transitionShowing,
    leftDeckView?.track?.id,
    rightDeckView?.track?.id,
    visualActiveIndex,
  ]);

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
      new CustomEvent(DETAIL_EVENT, { detail: { source: "player-deck" } }),
    );
  };

  const dropOnDeck = async (
    event: React.DragEvent<HTMLElement>,
    side: "left" | "right",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const ids = readTrackDragIds(event.dataTransfer);
    setDeckDropSide(null);
    finishTrackDrop();
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => api.track(id)));
    const dropped = results
      .filter((result): result is PromiseFulfilledResult<Track> => result.status === "fulfilled")
      .map((result) => result.value);
    const first = dropped[0];
    if (!first) {
      setNotice("拖入的曲目已经不在曲库里");
      return;
    }
    const droppingOnCurrent = (side === "left" ? 0 : 1) === visualActiveIndex;
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
    if (!isTrackDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDeckDropSide(side);
  };

  const downloadStreamTrack = (streamTrack: Track | null) => {
    const source = streamTrack && isStreamTrack(streamTrack) ? streamMeta(streamTrack)?.source : null;
    if (!source || enqueueBusy) return;
    setEnqueueBusy(true);
    void enqueueDownload([source], { quality: defaultQuality })
      .then(() => openQueuePanel())
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
        (leftPerformanceState ? leftPerformanceState.playing || leftPerformanceState.desiredPlaying : undefined) ??
        (visualActiveIndex === 0 && deckPlaying),
      rate: leftPerformanceState?.rate ?? 1,
      cover: leftDeckView?.cover ?? "",
      loopStart: leftPerformanceState?.loopStart ?? null,
      loopLength: leftPerformanceState?.loopLength ?? null,
    },
    {
      track: rightDeckView?.track ?? null,
      active: visualActiveIndex === 1,
      position: deckTransportSeconds(1, rightDeckView?.track ?? null),
      duration:
        rightPerformanceState?.duration ??
        (visualActiveIndex === 1 ? playbackDuration : rightDeckView?.track?.duration ?? 0),
      playing:
        (rightPerformanceState ? rightPerformanceState.playing || rightPerformanceState.desiredPlaying : undefined) ??
        (visualActiveIndex === 1 && deckPlaying),
      rate: rightPerformanceState?.rate ?? 1,
      cover: rightDeckView?.cover ?? "",
      loopStart: rightPerformanceState?.loopStart ?? null,
      loopLength: rightPerformanceState?.loopLength ?? null,
    },
  ];
  const performanceDecksRef = useRef(performanceDecks);
  performanceDecksRef.current = performanceDecks;
  const performanceStemsRef = useRef(performanceStems);
  performanceStemsRef.current = performanceStems;
  const performanceStemModelRef = useRef(performanceStemModel);
  performanceStemModelRef.current = performanceStemModel;

  useEffect(() => {
    if (!dualDeck || stemRuntimeReadyKey !== desiredStemRuntimeKey || stemMode === "none") {
      setPerformanceStemModel(null);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    const refresh = () => {
      void api.stemModelStatus(stemMode, stemCompute).then((status) => {
        if (!alive) return;
        setPerformanceStemModel(status);
        if (status.state === "error" && status.error) {
          if (reportedStemModelErrorRef.current !== status.error) {
            reportedStemModelErrorRef.current = status.error;
            setNotice(`STEM 模型运行失败：${status.error}`);
          }
        } else if (status.state !== "error") {
          reportedStemModelErrorRef.current = "";
        }
        const fast = status.state === "queued" || status.state === "downloading";
        timer = window.setTimeout(refresh, fast ? 500 : 5000);
      }).catch((error: unknown) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        if (reportedStemModelErrorRef.current !== message) {
          reportedStemModelErrorRef.current = message;
          setNotice(`读取 STEM 模型状态失败：${message}`);
        }
        timer = window.setTimeout(refresh, 1000);
      });
    };
    refresh();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [desiredStemRuntimeKey, dualDeck, stemCompute, stemMode, stemRuntimeReadyKey]);

  const downloadPerformanceStemModel = () => {
    if (stemMode === "none") return;
    if (!performanceStemModel?.supported) {
      setNotice("当前平台暂不支持分轨");
      return;
    }
    if (performanceStemModel.state === "queued" || performanceStemModel.state === "downloading") return;
    reportedStemModelErrorRef.current = "";
    setNotice("");
    void api.downloadStemModel(stemMode, stemCompute).then(setPerformanceStemModel).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      reportedStemModelErrorRef.current = message;
      setNotice(`STEM 模型下载失败：${message}`);
    });
  };

  const stemGainIndex = (stem: StemName): 0 | 1 | 2 | 3 =>
    stem === "drums" ? 0 : stem === "bass" ? 1 : stem === "other" ? 2 : 3;
  const stemGainTimersRef = useRef<[number | null, number | null]>([null, null]);
  const stemGainDraftRef = useRef<[
    [number, number, number, number],
    [number, number, number, number],
  ]>([[1, 1, 1, 1], [1, 1, 1, 1]]);
  // STEM 启动要先创建异步推理流，而 EQ 是实时控制。两者若并发到达 actor，较早的
  // “全开/全增益”启动命令可能在第一次旋钮命令之后才落地，覆盖用户刚调好的值。
  // 每个 Deck 保持一个短串行通道：启动先写入 pending stream，紧随的 EQ 再更新同一
  // pending stream 的增益，等它真正安装时便已经是用户首次调节后的值。
  const stemModeTailsRef = useRef<[Promise<void>, Promise<void>]>([
    Promise.resolve(),
    Promise.resolve(),
  ]);
  const stemAutoArmRef = useRef<[boolean, boolean]>([true, true]);
  const applyStemModeNow = async (
    side: 0 | 1,
    trackId: number,
    enabled: boolean,
    mask: number,
  ) => {
    const deck = performanceDecksRef.current[side];
    const deckTrack = deck.track;
    if (!deckTrack || deckTrack.id !== trackId) return;
    let status = performanceStemsRef.current[side].status;
    if (!status || status.trackId !== deckTrack.id || status.state !== "ready" || !status.cachePath) {
      const fetched = await api.trackStemStatus(
        deckTrack.id,
        stemMode,
        stemCompute,
        deck.position,
        deck.playing,
      );
      if (performanceDecksRef.current[side].track?.id !== trackId) return;
      status = fetched;
      setPerformanceStems((current) => {
        if (sameStemStatus(current[side].status, fetched)) return current;
        const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
          { ...current[0] },
          { ...current[1] },
        ];
        next[side].status = status;
        return next;
      });
    }
    if (!status || status.trackId !== deckTrack.id || status.state !== "ready" || !status.cachePath) {
      throw new Error("STEM 尚未就绪");
    }
    const nextGains = [...stemGainDraftRef.current[side]] as [number, number, number, number];
    if (enabled) {
      setPerformanceStems((current) => {
        const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
          { ...current[0] },
          { ...current[1] },
        ];
        next[side].enabled = true;
        next[side].mask = mask & 0b1111;
        if (stemGainTimersRef.current[side] === null) {
          next[side].gains = nextGains;
        }
        return next;
      });
    }
    await ensurePerformanceDeck(side, deck.playing);
    if (performanceDecksRef.current[side].track?.id !== trackId) return;
    // 读取即时 draft，而非排队前的 React state 快照。这样在 STEM 流准备期间发生的
    // 第一次 EQ 拧动会随流的首次安装一起交给渲染线程。
    const liveGains = [...stemGainDraftRef.current[side]] as [number, number, number, number];
    try {
      await playerRuntime.setDeckStems(deckTrack.id, enabled, status.cachePath, mask, liveGains);
    } catch (error) {
      if (enabled) {
        setPerformanceStems((current) => {
          const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
            { ...current[0] },
            { ...current[1] },
          ];
          next[side].enabled = false;
          return next;
        });
      }
      throw error;
    }
    if (performanceDecksRef.current[side].track?.id !== trackId) return;
    setPerformanceStems((current) => {
      const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
        { ...current[0] },
        { ...current[1] },
      ];
      next[side].enabled = enabled;
      next[side].mask = mask & 0b1111;
      if (stemGainTimersRef.current[side] === null) {
        next[side].gains = liveGains;
      }
      return next;
    });
  };
  const applyStemMode = (
    side: 0 | 1,
    enabled: boolean,
    mask: number,
  ) => {
    const trackId = performanceDecksRef.current[side].track?.id;
    if (trackId === undefined) return Promise.reject(new Error("STEM 尚未就绪"));
    const operation = stemModeTailsRef.current[side].then(() =>
      applyStemModeNow(side, trackId, enabled, mask),
    );
    // A failed request must not prevent the next EQ gesture from reaching the Deck.
    stemModeTailsRef.current[side] = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const applyStemModeRef = useRef(applyStemMode);
  applyStemModeRef.current = applyStemMode;

  const setPerformanceStemGain = (side: 0 | 1, stem: StemName, value: number) => {
    const deck = performanceDecksRef.current[side];
    const deckTrack = deck.track;
    if (performanceStemModelRef.current?.state !== "ready") return;
    if (!deckTrack || !usesLocalLibraryRecord(deckTrack)) return;
    const current = performanceStemsRef.current[side];
    const gains = [...(
      stemGainTimersRef.current[side] !== null
        ? stemGainDraftRef.current[side]
        : current.gains
    )] as [number, number, number, number];
    gains[stemGainIndex(stem)] = clampStemGain(value);
    stemGainDraftRef.current[side] = gains;
    pendingStemGainTrackRef.current[side] = deckTrack.id;
    // STEM EQ 旋钮以指针速度更新本地控件；IPC 合并成 50ms 尾随一次。
    // 引擎在渲染线程直接混音，这个频率下的听觉依然是无级连续的。
    setPerformanceStems((states) => {
      const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
        { ...states[0] },
        { ...states[1] },
      ];
      next[side].gains = gains;
      if (
        !loopHoldsOriginalRef.current[side]
        && deck.loopStart === null
      ) {
        next[side].enabled = true;
      }
      return next;
    });
    if (loopHoldsOriginalRef.current[side] || deck.loopStart !== null) {
      if (!current.enabled) return;
    }
    if (stemGainTimersRef.current[side] !== null) return;
    stemGainTimersRef.current[side] = window.setTimeout(() => {
      stemGainTimersRef.current[side] = null;
      const live = performanceStemsRef.current[side];
      if (!stemGainRequestReady(live.status, deckTrack.id)) return;
      void applyStemModeRef.current(side, true, live.mask)
        .then(() => {
          if (pendingStemGainTrackRef.current[side] === deckTrack.id) {
            pendingStemGainTrackRef.current[side] = null;
          }
        })
        .catch((error: unknown) => {
          setNotice(`STEM EQ 失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }, 50);
  };

  const setPerformanceLoop = (side: 0 | 1, start: number, length: number) => {
    const deckTrack = performanceDecks[side].track;
    if (!deckTrack) return;
    void (async () => {
      loopHoldsOriginalRef.current[side] = true;
      pendingStemActionRef.current[side] = null;
      await playerRuntime.setDeckLoop(deckTrack.id, start, length);
    })().catch((error: unknown) => {
      loopHoldsOriginalRef.current[side] = false;
      setNotice(`LOOP 失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const clearPerformanceLoop = (side: 0 | 1) => {
    const deckTrack = performanceDecks[side].track;
    if (!deckTrack) return;
    loopHoldsOriginalRef.current[side] = false;
    void playerRuntime.clearDeckLoop(deckTrack.id).catch((error: unknown) => {
      setNotice(`退出 LOOP 失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const startPerformanceStems = (side: 0 | 1) => {
    if (stemMode === "none") return;
    if (performanceStemModel?.state !== "ready") {
      downloadPerformanceStemModel();
      return;
    }
    const deckTrack = performanceDecks[side].track;
    if (!deckTrack || !usesLocalLibraryRecord(deckTrack)) {
      setNotice("STEM 仅支持本机曲库文件");
      return;
    }
    if (!stemGainRequestReady(performanceStemsRef.current[side].status, deckTrack.id)) {
      pendingStemActionRef.current[side] = "all";
      return;
    }
    loopHoldsOriginalRef.current[side] = false;
    // The audible worker publishes the same separated blocks used by the rails. Starting an
    // additional display scan first wastes an accelerator tile and can delay the first audio job.
    void applyStemMode(side, true, allStemMask).catch((error: unknown) => {
      setNotice(`STEM 切换失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const togglePerformanceStem = (side: 0 | 1, stem: StemName) => {
    if (stemMode === "none") return;
    if (performanceStemModel?.state !== "ready") {
      downloadPerformanceStemModel();
      return;
    }
    loopHoldsOriginalRef.current[side] = false;
    const deckTrack = performanceDecks[side].track;
    if (!deckTrack || !usesLocalLibraryRecord(deckTrack)) {
      setNotice("STEM 仅支持本机曲库文件");
      return;
    }
    if (!stemGainRequestReady(performanceStemsRef.current[side].status, deckTrack.id)) {
      pendingStemActionRef.current[side] = stem;
      return;
    }
    const current = performanceStems[side];
    const baseMask = current.enabled ? current.mask : allStemMask;
    const nextMask = baseMask ^ stemBit(stem);
    void applyStemMode(side, true, nextMask).catch((error: unknown) => {
      setNotice(`STEM 切换失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const restorePerformanceOriginal = (side: 0 | 1) => {
    if (!performanceStems[side].enabled) return;
    stemAutoArmRef.current[side] = false;
    void applyStemMode(side, false, performanceStems[side].mask).catch((error: unknown) => {
      setNotice(`原曲切换失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const ensurePerformanceStemWaveScan = useCallback((side: 0 | 1) => {
    if (
      stemMode === "none"
      || performanceStemModel?.state !== "ready"
      || stemRuntimeReadyKey !== desiredStemRuntimeKey
    ) return;
    const requestMode = stemMode;
    const requestCompute = stemCompute;
    const deck = performanceDecksRef.current[side];
    const deckTrack = deck.track;
    if (!deckTrack || !usesLocalLibraryRecord(deckTrack)) return;
    void api.separateTrackStems(deckTrack.id, deck.position, {
      mode: stemMode,
      compute: stemCompute,
      duration: deck.duration || deckTrack.duration || 0,
      deck: side,
      playing: deck.playing,
    }).then((status) => {
      const selected = stemPreferenceRef.current;
      if (selected?.mode !== requestMode || selected.compute !== requestCompute) return;
      if (performanceDecksRef.current[side].track?.id !== deckTrack.id) return;
      setPerformanceStems((current) => {
        if (sameStemStatus(current[side].status, status)) return current;
        const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
          { ...current[0] },
          { ...current[1] },
        ];
        next[side].status = status;
        return next;
      });
    }).catch((error: unknown) => {
      const selected = stemPreferenceRef.current;
      if (selected?.mode !== requestMode || selected.compute !== requestCompute) return;
      if (performanceDecksRef.current[side].track?.id !== deckTrack.id) return;
      const message = error instanceof Error ? error.message : String(error);
      if (reportedStemTrackErrorsRef.current[side] === message) return;
      reportedStemTrackErrorsRef.current[side] = message;
      setNotice(`Deck ${side === 0 ? "A" : "B"} 自动 STEM 准备失败：${message}`);
    });
  }, [
    desiredStemRuntimeKey,
    performanceStemModel?.state,
    stemCompute,
    stemMode,
    stemRuntimeReadyKey,
  ]);

  const releasePerformanceStemWaveScan = useCallback((trackId: number) => {
    void api.releaseTrackStems(trackId).catch(() => undefined);
  }, []);

  const stemPreferenceRef = useRef<{ mode: typeof stemMode; compute: typeof stemCompute } | null>(null);
  const stemRuntimeTailRef = useRef<Promise<void>>(Promise.resolve());
  const stemRuntimeGenerationRef = useRef(0);
  useEffect(() => {
    if (!dualDeck) return;
    const previous = stemPreferenceRef.current;
    if (previous?.mode === stemMode && previous.compute === stemCompute) return;
    stemPreferenceRef.current = { mode: stemMode, compute: stemCompute };
    const generation = ++stemRuntimeGenerationRef.current;
    const deckSnapshots = ([0, 1] as const).map((side) => ({
      side,
      stem: performanceStemsRef.current[side],
      trackId: performanceDecksRef.current[side].track?.id,
    }));
    const priorDeckTails = [...stemModeTailsRef.current] as [Promise<void>, Promise<void>];
    const priorRuntime = stemRuntimeTailRef.current;

    setStemRuntimeReadyKey(null);
    setPerformanceStemModel(null);
    deckSnapshots.forEach(({ side }) => {
      pendingStemActionRef.current[side] = null;
      pendingStemGainTrackRef.current[side] = null;
      loopHoldsOriginalRef.current[side] = false;
      stemAutoArmRef.current[side] = true;
      stemGainDraftRef.current[side] = [1, 1, 1, 1];
      if (stemGainTimersRef.current[side] !== null) {
        window.clearTimeout(stemGainTimersRef.current[side]!);
        stemGainTimersRef.current[side] = null;
      }
    });
    setPerformanceStems([
      { status: null, enabled: false, mask: allStemMask, gains: [1, 1, 1, 1] },
      { status: null, enabled: false, mask: allStemMask, gains: [1, 1, 1, 1] },
    ]);

    const waitForInstalledOriginal = async (side: 0 | 1, trackId: number) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const deck = playerRuntime.state().decks[side];
        if (deck.trackId !== trackId || !deck.stemEnabled) return;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error(`Deck ${side === 0 ? "A" : "B"} 未能安全切回原曲`);
    };

    const deckRetirements = deckSnapshots.map(({ side, stem, trackId }) => {
      const retirement = priorRuntime
        .then(() => priorDeckTails[side])
        .then(async () => {
          if (trackId === undefined) return;
          const installed = playerRuntime.state().decks[side];
          if (stem.enabled || (installed.trackId === trackId && installed.stemEnabled)) {
            await playerRuntime.setDeckStems(
              trackId,
              false,
              stem.status?.cachePath ?? "",
              stem.mask,
              stem.gains,
            );
            await waitForInstalledOriginal(side, trackId);
          }
        });
      stemModeTailsRef.current[side] = retirement.then(
        () => undefined,
        () => undefined,
      );
      return retirement;
    });

    const operation = Promise.all(deckRetirements)
      .then(async () => {
        const trackIds = [...new Set(
          deckSnapshots
            .map(({ trackId }) => trackId)
            .filter((trackId): trackId is number => trackId !== undefined),
        )];
        await Promise.all(trackIds.map((trackId) => api.releaseTrackStems(trackId)));
        return api.activateStemRuntime(stemMode, stemCompute);
      })
      .then((status) => {
        if (stemRuntimeGenerationRef.current !== generation) return;
        setStemRuntimeReadyKey(desiredStemRuntimeKey);
        setPerformanceStemModel(stemMode === "none" ? null : status);
      })
      .catch((error: unknown) => {
        if (stemRuntimeGenerationRef.current !== generation) return;
        stemPreferenceRef.current = null;
        setStemRuntimeReadyKey(null);
        setPerformanceStemModel(null);
        setNotice(`切换 STEM runtime 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    stemRuntimeTailRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
  }, [allStemMask, desiredStemRuntimeKey, dualDeck, playerRuntime, stemCompute, stemMode]);

  useEffect(() => {
    if (
      !dualDeck
      || stemMode === "none"
      || stemRuntimeReadyKey !== desiredStemRuntimeKey
      || performanceStemModel?.state !== "ready"
    ) return;
    let alive = true;
    const nextTrackIds: [number | null, number | null] = [
      performanceDecks[0].track?.id ?? null,
      performanceDecks[1].track?.id ?? null,
    ];
    const priorTrackIds = stemDeckTrackIdsRef.current;
    ([0, 1] as const).forEach((side) => {
      const prior = priorTrackIds[side];
      if (prior !== null && prior !== nextTrackIds[side] && !nextTrackIds.includes(prior)) {
        // Whole-track display fill is intentionally lease-bound. Releasing an old Deck must
        // cancel it immediately instead of letting hidden Spleeter4 work compete with the live Deck.
        void api.releaseTrackStems(prior).catch(() => undefined);
      }
    });
    setPerformanceStems((current) => {
      const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
        { ...current[0] },
        { ...current[1] },
      ];
      ([0, 1] as const).forEach((side) => {
        if (stemDeckTrackIdsRef.current[side] === nextTrackIds[side]) return;
        next[side] = { status: null, enabled: false, mask: allStemMask, gains: [1, 1, 1, 1] };
        pendingStemActionRef.current[side] = null;
        pendingStemGainTrackRef.current[side] = null;
        loopHoldsOriginalRef.current[side] = false;
        stemAutoArmRef.current[side] = true;
        reportedStemTrackErrorsRef.current[side] = "";
        stemGainDraftRef.current[side] = [1, 1, 1, 1];
        // Keep the tail itself: late work checks track identity before publishing, while replacing
        // the Promise here would let an old enable/disable overtake a model-switch retirement.
        if (stemGainTimersRef.current[side] !== null) {
          window.clearTimeout(stemGainTimersRef.current[side]!);
          stemGainTimersRef.current[side] = null;
        }
      });
      stemDeckTrackIdsRef.current = nextTrackIds;
      return next;
    });
    const refresh = () => {
      ([0, 1] as const).forEach((side) => {
        const deck = performanceDecksRef.current[side];
        const deckTrack = deck.track;
        if (!deckTrack || !usesLocalLibraryRecord(deckTrack)) return;
        void api.trackStemStatus(
          deckTrack.id,
          stemMode,
          stemCompute,
          deck.position,
          deck.playing,
        ).then((status) => {
          if (!alive) return;
          if (status.state === "error" && status.error) {
            if (reportedStemTrackErrorsRef.current[side] !== status.error) {
              reportedStemTrackErrorsRef.current[side] = status.error;
              setNotice(`Deck ${side === 0 ? "A" : "B"} 分轨失败：${status.error}`);
            }
          } else if (status.state !== "error") {
            reportedStemTrackErrorsRef.current[side] = "";
          }
          setPerformanceStems((current) => {
            if (sameStemStatus(current[side].status, status)) return current;
            const next: [PerformanceStemDeckModel, PerformanceStemDeckModel] = [
              { ...current[0] },
              { ...current[1] },
            ];
            next[side].status = status;
            return next;
          });
        }).catch(() => {
          // The explicit start action reports endpoint failures; passive polling stays silent.
        });
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 750);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [
    dualDeck,
    performanceDecks[0].track?.id,
    performanceDecks[1].track?.id,
    performanceStemModel?.state,
    desiredStemRuntimeKey,
    stemCompute,
    stemMode,
    stemRuntimeReadyKey,
  ]);

  useEffect(() => {
    if (dualDeck) return;
    const trackIds = [...new Set(stemDeckTrackIdsRef.current.filter((id): id is number => id !== null))];
    stemDeckTrackIdsRef.current = [null, null];
    trackIds.forEach((trackId) => {
      // Closing the Performance surface must not leave an invisible viewport scan using the
      // shared inference device. The native live playback source keeps its own audio lease.
      void api.releaseTrackStems(trackId).catch(() => undefined);
    });
  }, [dualDeck]);

  useEffect(() => {
    ([0, 1] as const).forEach((side) => {
      const pending = pendingStemActionRef.current[side];
      const status = performanceStems[side].status;
      const deckTrack = performanceDecks[side].track;
      const pendingGain = pendingStemGainTrackRef.current[side] === deckTrack?.id;
      const shouldAutoEnable = stemAutoArmRef.current[side]
        && !pending
        && !pendingGain
        && !performanceStems[side].enabled
        && stemMode !== "none"
        && stemRuntimeReadyKey === desiredStemRuntimeKey;
      if ((!pending && !pendingGain && !shouldAutoEnable) || status?.state !== "ready" || status.trackId !== deckTrack?.id) return;
      if (loopHoldsOriginalRef.current[side]) return;
      const mask = pending === "all"
        ? allStemMask
        : pending
          ? allStemMask ^ stemBit(pending)
          : shouldAutoEnable
            ? allStemMask
            : performanceStemsRef.current[side].mask;
      if (shouldAutoEnable) stemAutoArmRef.current[side] = false;
      void applyStemMode(side, true, mask)
        .then(() => {
          if (pendingStemActionRef.current[side] === pending) pendingStemActionRef.current[side] = null;
          if (pendingStemGainTrackRef.current[side] === deckTrack.id) {
            pendingStemGainTrackRef.current[side] = null;
          }
        })
        .catch((error: unknown) => {
          if (shouldAutoEnable) stemAutoArmRef.current[side] = true;
          setNotice(`STEM 切换失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
  }, [
    allStemMask,
    desiredStemRuntimeKey,
    stemMode,
    stemRuntimeReadyKey,
    performanceDecks[0].track?.id,
    performanceDecks[1].track?.id,
    performanceStems[0].enabled,
    performanceStems[1].enabled,
    performanceStems[0].status?.state,
    performanceStems[1].status?.state,
    performanceStems[0].status?.trackId,
    performanceStems[1].status?.trackId,
  ]);

  const savePerformanceCues = async (deckTrack: Track, cuePoints: CuePoint[]) => {
    if (!usesLocalLibraryRecord(deckTrack)) throw new Error("在线与外置曲目暂不写回本地 Cue");
    const updated = await updateTrack(deckTrack.id, { cue_points: cuePoints });
    if (trackRef.current?.id === updated.id) setTrack(updated);
    if (predictedRef.current?.id === updated.id) {
      predictedRef.current = updated;
      setPredicted(updated);
    }
    setRetainedDecks((current) =>
      current.map((item) => (item?.id === updated.id ? updated : item)) as [Track | null, Track | null],
    );
    setPerformanceDeckOverrides((current) =>
      current.map((item) => (item?.id === updated.id ? updated : item)) as [Track | null, Track | null],
    );
  };

  const savePerformanceMainCue = async (deckTrack: Track, cueMs: number) => {
    if (!usesLocalLibraryRecord(deckTrack)) throw new Error("在线与外置曲目暂不写回本地 Cue");
    const updated = await updateTrack(deckTrack.id, { cue_ms: cueMs });
    if (trackRef.current?.id === updated.id) setTrack(updated);
    if (predictedRef.current?.id === updated.id) {
      predictedRef.current = updated;
      setPredicted(updated);
    }
    setRetainedDecks((current) =>
      current.map((item) => (item?.id === updated.id ? updated : item)) as [Track | null, Track | null],
    );
    setPerformanceDeckOverrides((current) =>
      current.map((item) => (item?.id === updated.id ? updated : item)) as [Track | null, Track | null],
    );
  };

  const focusPerformanceDeck = (side: 0 | 1, deckTrack: Track, at: number) => {
    visualActiveIndexRef.current = side;
    setVisualActiveIndex(side);
    if (trackRef.current?.id !== deckTrack.id) {
      // Performance 已自行装盘，跳过单轨 load effect；否则会回收另一侧并破坏同时播放。
      djViaRef.current = deckTrack.id;
      trackRef.current = deckTrack;
      setTrack(deckTrack);
      if (usesLocalLibraryRecord(deckTrack)) selectTrack(deckTrack);
    }
    positionRef.current = at;
    setPosition(at);
    setDuration(deckTrack.duration ?? 0);
  };

  const ensurePerformanceDeck = async (side: 0 | 1, autoplay: boolean) => {
    const deck = performanceDecks[side];
    const deckTrack = deck.track;
    if (!deckTrack) return;
    const nativeDecks = playerRuntime.state().decks;
    if (nativeDecks[side].trackId === deckTrack.id) return;
    if (nativeDecks[side === 0 ? 1 : 0].trackId === deckTrack.id) {
      throw new Error(`这首曲目实际位于 Deck ${side === 0 ? "B" : "A"}`);
    }
    const inFlight = performanceDeckEnsureRef.current[side];
    if (inFlight?.trackId === deckTrack.id) return inFlight.promise;
    const generation = ++performanceDeckEnsureGenerationRef.current[side];
    const promise = (async () => {
      if (isStreamTrack(deckTrack)) await resolvePendingStreamTrack(deckTrack);
      // An older resolve may finish after the user replaced this side. Do not let it install the
      // wrong Deck merely because a high-frequency fader callback was still awaiting it.
      if (performanceDeckEnsureGenerationRef.current[side] !== generation) return;
      await playerRuntime.loadDeck(side, {
        src: mediaUrlForTrack(deckTrack),
        track: deckTrack,
        position: deck.position,
        rate: deck.rate,
        autoplay,
        artworkUrl: playbackCoverUrl(deckTrack),
      });
    })();
    performanceDeckEnsureRef.current[side] = { trackId: deckTrack.id, promise };
    try {
      await promise;
    } finally {
      if (performanceDeckEnsureRef.current[side]?.promise === promise) {
        performanceDeckEnsureRef.current[side] = null;
      }
    }
  };

  const installPerformanceTrack = async (
    side: 0 | 1,
    deckTrack: Track,
    autoplay: boolean,
    requestedPosition?: number,
  ) => {
    const nativeStateBefore = playerRuntime.state();
    const currentBefore = trackRef.current;
    const currentSideBefore = currentBefore
      ? nativeStateBefore.decks.findIndex((deck) => deck.trackId === currentBefore.id)
      : -1;
    const otherSide: 0 | 1 = side === 0 ? 1 : 0;
    const otherTrack = performanceDecks[otherSide].track;
    if (otherTrack?.id === deckTrack.id) {
      throw new Error(`这首曲目已经在 Deck ${otherSide === 0 ? "A" : "B"}`);
    }
    if (isStreamTrack(deckTrack)) await resolvePendingStreamTrack(deckTrack);
    const at = Math.max(0, requestedPosition ?? (deckTrack.first_beat ?? 0));
    const nativeDeck = nativeStateBefore.decks[side];
    if (nativeDeck.trackId === deckTrack.id) {
      await playerRuntime.pauseDeck(side);
      await playerRuntime.seekDeck(side, at);
      await playerRuntime.setDeckRate(side, 1);
      if (autoplay) await playerRuntime.playDeck(side);
    } else {
      await playerRuntime.loadDeck(side, {
        src: mediaUrlForTrack(deckTrack),
        track: deckTrack,
        position: at,
        rate: 1,
        autoplay,
        artworkUrl: playbackCoverUrl(deckTrack),
      });
    }
    setPerformanceDeckOverrides((current) => {
      const next: [Track | null, Track | null] = [current[0], current[1]];
      if ((currentSideBefore === 0 || currentSideBefore === 1) && currentBefore) {
        next[currentSideBefore] = currentBefore;
      }
      next[side] = deckTrack;
      return next;
    });
    setRetainedDecks((current) => {
      const next: [Track | null, Track | null] = [current[0], current[1]];
      next[side] = deckTrack;
      return next;
    });
    if (autoplay || side === visualActiveIndexRef.current) {
      focusPerformanceDeck(side, deckTrack, at);
    }
    if (autoplay) {
      transportHandledRef.current = true;
      commitPlaying(true);
    }
    setNotice("");
  };
  loadPerformanceTrackRef.current = installPerformanceTrack;

  const wasDualDeckRef = useRef(dualDeck);
  useEffect(() => {
    const wasDual = wasDualDeckRef.current;
    wasDualDeckRef.current = dualDeck;
    if (dualDeck || !wasDual) return;
    // 收起 DJ 台后回到管理器单路：停掉非正主 Deck，避免底栏只显示一首却仍有两路出声。
    const frontId = trackRef.current?.id ?? null;
    ([0, 1] as const).forEach((side) => {
      const deck = playerRuntime.state().decks[side];
      if (!deck.trackId || (frontId !== null && deck.trackId === frontId)) return;
      if (!deck.playing && !deck.desiredPlaying) return;
      void playerRuntime.pauseDeck(side).catch(() => undefined);
    });
  }, [dualDeck, playerRuntime]);

  const loadDroppedPerformanceTrack = async (side: 0 | 1, ids: number[]) => {
    const id = ids[0];
    if (!Number.isFinite(id)) return;
    try {
      const dropped = await api.track(id);
      const at = Math.max(0, dropped.first_beat ?? 0);
      await installPerformanceTrack(side, dropped, useDjConfig.getState().playOnLoad, at);
    } catch (error: unknown) {
      setNotice(`装入 Deck ${side === 0 ? "A" : "B"} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const performanceWorkspace = (
    <PerformanceWorkspace
      decks={performanceDecks}
      stems={performanceStems}
      stemModel={performanceStemModel}
      stemMode={stemMode}
      masterVolume={playerVolume}
      embedded={workMode === "dj"}
      onClose={() => {
        setNotice("");
        setPerformanceOpen(false);
      }}
      onSeek={(side, detail) => {
        const deckTrack = performanceDecks[side].track;
        if (!deckTrack) return;
        if (detail.preview) return;
        focusPerformanceDeck(side, deckTrack, detail.position);
        void ensurePerformanceDeck(side, false)
          .then(() => playerRuntime.seekDeck(side, detail.position))
          .catch((error: unknown) => setNotice(`Deck 跳转失败：${error instanceof Error ? error.message : String(error)}`));
      }}
      onJogSeek={(side, position) => {
        const deckTrack = performanceDecks[side].track;
        // Hardware jog input is never an implicit load/focus request. A stale visual row used to
        // call ensurePerformanceDeck for every tick, which could replace a source, restart a
        // stream at 0, or flip the global player while the other Deck was performing.
        if (!deckTrack || playerRuntime.state().decks[side].trackId !== deckTrack.id) return;
        void playerRuntime.seekDeck(side, position).catch(() => {
          // This is a hot input path. The next physical-state snapshot is authoritative; showing
          // a notice for every dropped tick would itself make the Performance surface stutter.
        });
      }}
      onJogNudge={(side, amount) => {
        const deckTrack = performanceDecks[side].track;
        if (!deckTrack || playerRuntime.state().decks[side].trackId !== deckTrack.id) return;
        void playerRuntime.nudgeDeck(side, amount).catch(() => {
          // See onJogSeek: do not turn a transient controller packet into a global UI mutation.
        });
      }}
      onJogScratchTick={(side, delta) => {
        const deckTrack = performanceDecks[side].track;
        if (!deckTrack || playerRuntime.state().decks[side].trackId !== deckTrack.id) return;
        void playerRuntime.scratchDeck(side, delta).catch(() => {
          // A dropped vinyl tick must not become a notice flood; the next packet still sums.
        });
      }}
      onJogScratchStart={(side) => {
        const deckTrack = performanceDecks[side].track;
        const physical = playerRuntime.state().decks[side];
        if (!deckTrack || physical.trackId !== deckTrack.id) return;
        const generation = midiScratchGenerationRef.current[side] + 1;
        midiScratchGenerationRef.current[side] = generation;
        const hold = beginMidiScratchHold(
          generation,
          deckTrack.id,
          physical.playing || physical.desiredPlaying,
        );
        midiScratchHoldsRef.current[side] = hold;
        if (!hold.resumeOnRelease) return;
        // This is a physical-deck command, deliberately not ensurePerformanceDeck: touching a
        // platter must freeze its callback cursor immediately, never reload/focus a Deck or send
        // a hidden PauseDeck.
        void playerRuntime.setDeckScratchHeld(side, true).catch(() => {
          // Controller touches can race a Deck replacement; the next snapshot is authoritative.
        });
      }}
      onJogScratchRelease={(side, finalPosition) => {
        const hold = midiScratchHoldsRef.current[side];
        const generation = hold?.generation;
        void (async () => {
          const physical = playerRuntime.state().decks[side];
          if (hold && physical.trackId !== hold.trackId) return;
          const ownsHold = hold
            ? canResumeMidiScratchHold(
              midiScratchHoldsRef.current[side],
              hold.generation,
              physical.trackId,
            )
            : false;
          if (finalPosition !== null && Number.isFinite(finalPosition)) {
            // Seek to the touch-down/scratch cursor even if the hold command never reached the
            // engine. Otherwise note-off leaves the Deck at wherever it walked while the waveform
            // was frozen. Seek promotion releases a playing hold without a Play/Pause toggle.
            if (hold?.resumeOnRelease && !ownsHold) return;
            await playerRuntime.seekDeck(side, finalPosition);
            return;
          }
          if (ownsHold) await playerRuntime.setDeckScratchHeld(side, false);
        })().catch(() => {
          // A failed final seek must not leave an otherwise playing Deck frozen under a vanished
          // gesture. Do not turn a controller race into a global notice flood.
          if (hold && canResumeMidiScratchHold(
            midiScratchHoldsRef.current[side],
            hold.generation,
            playerRuntime.state().decks[side].trackId,
          )) {
            void playerRuntime.setDeckScratchHeld(side, false);
          }
        }).finally(() => {
          if (generation != null && midiScratchHoldsRef.current[side]?.generation === generation) {
            midiScratchHoldsRef.current[side] = null;
          }
        });
      }}
      onScratchRelease={(side, position, resume) => {
        const deckTrack = performanceDecks[side].track;
        if (!deckTrack) return;
        const installed = playerRuntime.state().decks[side].trackId === deckTrack.id;
        const seek = () => playerRuntime.seekDeck(side, position);
        if (installed) {
          // `onScratchHold` has already joined commandTail. The coordinator keeps that hold until
          // this replacement source is ready, then releases it without a PlayDeck/PauseDeck turn.
          void seek().catch((error: unknown) => {
            if (resume) void playerRuntime.setDeckScratchHeld(side, false);
            setNotice(`Deck 刮擦跳转失败：${error instanceof Error ? error.message : String(error)}`);
          });
          return;
        }
        // A visual row may be retained after an external change. It is not a hot platter path,
        // but preserve ordinary waveform behavior rather than leaving that row stuck.
        void ensurePerformanceDeck(side, resume)
          .then(seek)
          .catch((error: unknown) => {
            setNotice(`Deck 刮擦跳转失败：${error instanceof Error ? error.message : String(error)}`);
          });
      }}
      onScratchHold={(side) => {
        const deckTrack = performanceDecks[side].track;
        const physical = playerRuntime.state().decks[side];
        // Do not await ensurePerformanceDeck here. Pointer-up must be queued behind this exact
        // callback hold, but the Deck's logical playing state remains untouched throughout.
        if (!deckTrack || physical.trackId !== deckTrack.id || (!physical.playing && !physical.desiredPlaying)) return;
        void playerRuntime.setDeckScratchHeld(side, true).catch((error: unknown) => {
          setNotice(`Deck 刮擦接管失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }}
      onTrackDrop={(side, ids) => void loadDroppedPerformanceTrack(side, ids)}
      onTogglePlay={(side) => {
        const deck = performanceDecks[side];
        const deckTrack = deck.track;
        if (!deckTrack) return;
        focusPerformanceDeck(side, deckTrack, deck.position);
        void ensurePerformanceDeck(side, !deck.playing)
          .then(() => deck.playing ? playerRuntime.pauseDeck(side) : playerRuntime.playDeck(side))
          .catch((error: unknown) => setNotice(`Deck 播放失败：${error instanceof Error ? error.message : String(error)}`));
      }}
      onMainCue={(side, cuePosition) => {
        const deck = performanceDecks[side];
        const deckTrack = deck.track;
        if (!deckTrack) return;
        focusPerformanceDeck(side, deckTrack, cuePosition);
        void ensurePerformanceDeck(side, false)
          .then(async () => {
            if (deck.playing) await playerRuntime.pauseDeck(side);
            await playerRuntime.seekDeck(side, cuePosition);
          })
          .catch((error: unknown) => setNotice(`主 CUE 失败：${error instanceof Error ? error.message : String(error)}`));
      }}
      onRateChange={(side, rate) => {
        const deckTrack = performanceDecks[side].track;
        if (!deckTrack) return false;
        return playerRuntime.setDeckRate(side, Math.min(2, Math.max(0.5, rate)))
          .then(() => true)
          .catch((error: unknown) => {
            setNotice(`TEMPO 调整失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
          });
      }}
      onMixerChange={(side, values, channelGain) => {
        performanceChannelGainsRef.current[side] = channelGain;
        const shownTrack = performanceDecks[side].track;
        const installedTrackId = playerRuntime.state().decks[side].trackId;
        // An empty channel strip is valid DJ state, not a routing error. The mixer effect submits
        // both sides on mount, so treating an empty Deck as a mismatch produced the screenshot's
        // warning before the user had even loaded that side.
        if (!shownTrack) return;
        // Never acknowledge a row-local control against a silent or different physical Deck.
        // This guard turns a stale row/Deck mapping into an explicit error instead of a knob that
        // moves while the audible source remains untouched.
        if (installedTrackId !== shownTrack.id) {
          setNotice(
            `Deck ${side === 0 ? "A" : "B"} 混音控制未应用：该排与实际音频 Deck 不一致`,
          );
          return;
        }
        void playerRuntime.setDeckMixer(side, {
          channelGain,
          trimDb: values.gain < 0 ? values.gain * 24 : values.gain * 6,
          lowDb: eqBandDb(values.low),
          midDb: eqBandDb(values.mid),
          highDb: eqBandDb(values.high),
          filter: values.filter,
        })
          .catch((error: unknown) => {
            setNotice(`Deck ${side === 0 ? "A" : "B"} 混音控制失败：${error instanceof Error ? error.message : String(error)}`);
          });
      }}
      onMasterVolumeChange={setMasterVolume}
      onStartStems={startPerformanceStems}
      onEnsureStemWaveScan={ensurePerformanceStemWaveScan}
      onReleaseStemWaveScan={releasePerformanceStemWaveScan}
      onDownloadStemModel={downloadPerformanceStemModel}
      onToggleStem={togglePerformanceStem}
      onStemGain={setPerformanceStemGain}
      onOriginalMode={restorePerformanceOriginal}
      onSetLoop={setPerformanceLoop}
      onClearLoop={clearPerformanceLoop}
      onSaveCuePoints={savePerformanceCues}
      onSaveMainCue={savePerformanceMainCue}
    />
  );

  return (
    <div
      className="kd-player"
      data-pip={pipDriving ? "true" : undefined}
      data-performance-dock={workMode !== "dj" && performanceOpen ? "true" : undefined}
    >
      {workMode === "dj"
        ? djWorkspaceHost
          ? createPortal(performanceWorkspace, djWorkspaceHost)
          : null
        : performanceOpen
          ? performanceWorkspace
          : null}
      {/* 这里不再渲染 <audio>：播放元素归 djEngine 所有（两台 deck 互换正主），
          事件监听在上面的 effect 里挂到 frontEl 上 */}
      {/* 不再挂隐藏视频实例：详情面板已有可见播放器，双实例会同时解码并
          互相回传 seek，画面就一卡一卡。音频是主时钟，打开详情时再对齐即可。 */}
      <LyricsHost current={track} next={predicted} allowDesktop={!video} />

      <div className="kd-player-leading">
        <PlayerDeck
          side="left"
          view={leftDeckView}
          active={visualActiveIndex === 0}
          spinning={Boolean(leftDeckView) && (transitionShowing || performanceDecks[0].playing)}
          transitioning={transitionShowing}
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
          ) : null}
          <label
            className="kd-player-volume"
            title={`音量 ${Math.round(playerVolume * 100)}%（↑↓）`}
            data-muted={playerVolume === 0 ? "true" : undefined}
          >
            <button
              type="button"
              className="kd-player-mute"
              aria-label={playerVolume === 0 ? "取消静音" : "静音"}
              aria-pressed={playerVolume === 0}
              title={playerVolume === 0 ? "取消静音" : "静音"}
              onClick={(event) => {
                // 喇叭在 label 里：不拦的话点一下还会顺带拨滑条。
                event.preventDefault();
                event.stopPropagation();
                if (playerVolume > 0) {
                  volumeBeforeMuteRef.current = playerVolume;
                  setMasterVolume(0);
                } else {
                  setMasterVolume(volumeBeforeMuteRef.current || 1);
                }
              }}
            >
              {playerVolume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={playerVolume}
              aria-label="播放器音量"
              style={{ "--kd-volume-fill": `${playerVolume * 100}%` } as CSSProperties}
              onChange={(event) => setMasterVolume(Number(event.currentTarget.value))}
            />
          </label>
          {/* 接播只留开关；旁边一颗悬浮键由音频歌词与视频/VJ 共用。 */}
          <div className="kd-player-dj">
          <button
            type="button"
            className="kd-player-step kd-player-djbtn"
            aria-label={djEnabled ? "关闭自动接播" : "开启自动接播"}
            aria-pressed={djEnabled}
            data-on={djEnabled ? "true" : undefined}
            disabled={mobileNative}
            title={
              mobileNative
                ? "移动端实时 DJ 引擎迁移中；普通播放已使用原生后台播放器"
                : !djEnabled
                  ? "自动接播：关。点一下开启"
                  : `自动接播：${djTransitions
                      .map((id) => DJ_TRANSITIONS.find((item) => item.id === id)?.label)
                      .filter(Boolean)
                      .join(" + ")}，${djBars} 小节。点一下关闭`
            }
            onClick={toggleDjEnabled}
          >
            <Blend size={14} />
          </button>
          <button
            type="button"
            className="kd-player-step kd-player-performancebtn"
            aria-label={performanceOpen ? "关闭双轨演出准备" : "打开双轨演出准备"}
            aria-pressed={performanceOpen}
            data-on={performanceOpen ? "true" : undefined}
            title={performanceOpen ? "关闭双轨演出准备" : "双轨演出准备：Beat Grid、Hot Cue 与 Loop"}
            onClick={() => setPerformanceOpen((open) => !open)}
          >
            <SlidersHorizontal size={13} />
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
        </div>

        <button
          type="button"
          className="kd-player-go"
          aria-label={
            pipDriving && pipSession?.source === "network"
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
          disabled={!displayTrack && !pipDriving}
          title={
            pipDriving && pipSession?.source === "network"
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
          {(pipDriving && pipSession?.source === "network" ? pipPlaying : playing) ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>

        <div className="kd-player-transport-side" data-side="right">
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
        <span className="kd-player-time kd-player-time-header" aria-label="剩余时间和总时长">
          {playbackDuration > 0
            ? `−${formatDuration(remaining)} / ${formatDuration(playbackDuration)}`
            : "−−:−− / −−:−−"}
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
            trackId={pipSession.trackId}
            track={track?.id === pipSession.trackId ? track : undefined}
            position={pipPosition}
            duration={pipDuration}
            preserveBarPhase={autoBeatSync}
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
            trackId={displayTrack.id}
            track={displayTrack}
            position={track?.id === displayTrack.id ? position : 0}
            duration={track?.id === displayTrack.id ? playbackDuration : (displayTrack.duration ?? 0)}
            preserveBarPhase={autoBeatSync && track?.id === displayTrack.id}
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
            trackId={track.id}
            track={track}
            position={position}
            duration={playbackDuration}
            height={42}
            dimPlayed
            preserveBarPhase={autoBeatSync}
          />
        ) : (
          <div className="kd-player-wave-idle" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
