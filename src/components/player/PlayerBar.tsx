import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AppWindow,
  Blend,
  Clapperboard,
  Disc3,
  FolderOpen,
  Library,
  ListMusic,
  Music2,
  PanelRight,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RefreshCw,
  Shuffle,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Waypoints,
} from "lucide-react";
import { api } from "../../lib/api";
import { analyzePlaying } from "../../lib/autoAnalyze";
import {
  hasPrevious,
  markPlayed,
  pickNext,
  previewNext,
  stepBack,
  trackById,
} from "../../lib/autoplay";
import {
  DJ_TRANSITIONS,
  djEngine,
  findOutroStart,
  mixSeconds,
  useDjConfig,
} from "../../lib/djMix";
import { useAppStore } from "../../stores/appStore";
import { useCrossfade, deckGain } from "../../lib/crossfade";
import { useHarmonicScope } from "../../lib/harmonicScope";
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
import { isStreamTrack, mediaUrlForTrack, streamCoverUrl } from "../../lib/streamTrack";
import {
  VIDEO_PREVIEW_MODE_UI,
  seekVideoPip,
  toggleVideoPip,
  useVideoPip,
} from "../../lib/videoPip";
import type { Track } from "../../types";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { useQueueStore } from "../../stores/queueStore";
import { InlineNotice } from "../common";
import { POSITION_EVENT, type PositionDetail } from "../library/TrackDetail";
import { PLAY_EVENT, parsePlayRequest, playTrack } from "../../lib/playTrack";
import { usePlayerShortcuts } from "../../lib/usePlayerShortcuts";
import { prefetchWaveform } from "../../lib/waveformCache";
import { DETAIL_EVENT } from "../library/TrackTable";
import { pointPatch, SEEK_EVENT, Waveform, type SeekDetail } from "../library/Waveform";
import { finishTrackDrop, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { nativeMobilePlayer, usesNativeMobilePlayer } from "../../lib/unifiedPlayer";

/** 广播播放位置的节流间隔：节拍网格的播放头不需要每帧更新。 */
const POSITION_BROADCAST_MS = 200;

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

function viewForTrack(track: Track): PlayerDeckView {
  const streaming = isStreamTrack(track);
  return {
    key: `${streaming ? "stream" : "library"}:${track.id}`,
    track,
    title: track.title || track.filename,
    subtitle: streaming ? "在线试听" : track.artist || "\u00a0",
    cover: streaming ? streamCoverUrl(track) : api.coverUrl(track.id, track.modified_at),
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
  onOpen(): void;
  onDragOver(event: React.DragEvent<HTMLButtonElement>): void;
  onDragLeave(event: React.DragEvent<HTMLButtonElement>): void;
  onDrop(event: React.DragEvent<HTMLButtonElement>): void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [view?.key]);
  // 接歌途中也只保留这两个身份；真正交接完成后，父组件才交换 active。
  const stateLabel = active ? "正在播放" : "下一首";
  return (
    <button
      type="button"
      className="kd-player-deck"
      data-side={side}
      data-active={active ? "true" : undefined}
      data-transitioning={transitioning ? "true" : undefined}
      data-empty={!view ? "true" : undefined}
      data-drop-active={dropActive ? "true" : undefined}
      aria-label={view ? `${stateLabel}：${view.title}` : side === "left" ? "左唱盘空闲" : "右唱盘空闲"}
      title={view ? `${stateLabel}：${view.title}` : "等待曲目"}
      onClick={onOpen}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
  );
}

export function PlayerBar() {
  const mobileNative = usesNativeMobilePlayer();
  const nativePlayer = mobileNative ? nativeMobilePlayer() : null;
  const selected = useLibraryStore(selectSelectedTrack);
  const selectTrack = useLibraryStore((state) => state.selectTrack);
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const mode = usePlayMode((state) => state.mode);
  const cycleMode = usePlayMode((state) => state.cycleMode);
  const scope = useHarmonicScope((state) => state.scope);
  const setScope = useHarmonicScope((state) => state.setScope);
  const queueIds = useQueueStore((state) => state.ids);
  const queueById = useQueueStore((state) => state.byId);
  const libraryFolder = useLibraryStore((state) => state.filter.folder);
  const librarySort = useLibraryStore((state) => state.filter.sort);
  const libraryOrder = useLibraryStore((state) => state.filter.order);
  const coplay = useCrossfade((state) => state.coplay);
  const fadeX = useCrossfade((state) => state.x);
  const djConfigured = useDjConfig((state) => state.enabled);
  // 阶段 1 的移动 owner 是系统连续播放服务；实时双 Deck 尚未达到等价前，
  // 明确标成不可用，不能亮着 DJ 灯却偷偷退化成硬切。
  const djEnabled = djConfigured && !mobileNative;
  const djTransitions = useDjConfig((state) => state.transitions);
  const djBars = useDjConfig((state) => state.bars);
  const applyInOutPoints = useDjConfig((state) => state.applyInOutPoints);
  const toggleDjEnabled = useDjConfig((state) => state.toggleEnabled);
  const showSettings = useAppStore((state) => state.showSettings);
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const openSettingsPanel = useAppStore((state) => state.openSettingsPanel);
  const listMode = useAppStore((state) => state.listMode);
  const pipMode = useVideoPip((state) => state.mode);
  const pipActive = useVideoPip((state) => state.active);
  const pipSystem = useVideoPip((state) => state.systemPip);
  const pipSession = useVideoPip((state) => state.session);
  const pipPosition = useVideoPip((state) => state.position);
  const pipDuration = useVideoPip((state) => state.duration);
  const pipPlaying = useVideoPip((state) => state.playing);
  const cyclePipMode = useVideoPip((state) => state.cycleMode);
  const pipModeUi = VIDEO_PREVIEW_MODE_UI[pipMode];
  const PipModeIcon = pipMode === "panel" ? PanelRight : AppWindow;
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
  /** 这首歌自动接歌挑不到候选：记下来别每次 timeupdate 都去问一遍后端。 */
  const djGaveUpRef = useRef<number | null>(null);
  /** 右侧空闲唱盘已经预告的候选；真正续播时交回 pickNext，随机模式也不会变卦。 */
  const predictedRef = useRef<Track | null>(null);
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

  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playerVolume, setPlayerVolume] = useState(() => {
    const raw = localStorage.getItem("kd-player-volume");
    if (raw === null) return 1;
    const saved = Number(raw);
    return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  });
  const playerVolumeRef = useRef(playerVolume);
  /** 点喇叭静音前记住的音量；取消静音时还原，而不是硬回到 100%。 */
  const volumeBeforeMuteRef = useRef(playerVolume > 0 ? playerVolume : 1);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [predicted, setPredicted] = useState<Track | null>(null);
  const [refreshingPrediction, setRefreshingPrediction] = useState(false);
  const deckMemoryRef = useRef<PlayerDeckMemory>(readPlayerDeckMemory());
  const [retainedDecks, setRetainedDecks] = useState<[Track | null, Track | null]>([null, null]);
  const [retainedDecksLoaded, setRetainedDecksLoaded] = useState(false);
  const [visualActiveIndex, setVisualActiveIndex] = useState<0 | 1>(deckMemoryRef.current.activeIndex);

  // 当前正主和预测出来的下一台 Deck 都提前读波形。真正接歌时只画 canvas，
  // 不在切换临界点再发整轨波形请求。
  useEffect(() => {
    prefetchWaveform(track);
    prefetchWaveform(predicted);
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
   * 放不出来的原因写在曲名底下。播放条是"现在在放什么"的唯一显示，
   * 按下播放却没有声音时，人的眼睛就在这里——错误理应也在这里。
   */
  const [notice, setNotice] = useState("");
  const [deckDropSide, setDeckDropSide] = useState<"left" | "right" | null>(null);

  // 给 [] 依赖的 PLAY_EVENT 监听读的镜像：拦截接歌要知道"现在在放谁"
  const trackRef = useRef<Track | null>(null);
  const playingRef = useRef(false);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const selectedRef = useRef(selected);
  useEffect(() => {
    trackRef.current = track;
  }, [track]);
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
  /** 播放状态既给 React 渲染，也给同一用户手势里的下一次事件判断；必须同步写 ref。 */
  const commitPlaying = useCallback((next: boolean) => {
    playingRef.current = next;
    setPlaying(next);
  }, []);
  /** 换曲/外部同步仍由 effect 执行；主按钮已在 click 调用栈内直接完成走带。 */
  const transportHandledRef = useRef(false);
  /** shadow deck 异步换手时，连续点击只有最后一个目标能更新正主元素。 */
  const seekGenerationRef = useRef(0);
  /**
   * 视频有多份呈现（浮窗、详情、系统 PiP），同一次校时可能经 seeked 再回到这里。
   * 去重必须放在真正调用音频引擎的边界，而不能只相信任一 UI 的 suppress 标记。
   */
  const lastCommittedSeekRef = useRef<{ trackId: number; position: number; at: number } | null>(null);
  const shouldCommitSeek = useCallback((trackId: number, position: number) => {
    const now = performance.now();
    const previous = lastCommittedSeekRef.current;
    if (
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
  }, []);
  /** 原生播放器换 source 会短暂回 idle；这不是用户/系统按了暂停。 */
  const nativeLoadInFlightRef = useRef(false);
  /** 后台队列已自行切歌时，React 只接管显示，不能再次 load 把进度打回开头。 */
  const nativeAdoptedTrackIdRef = useRef<number | null>(null);

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
    });
    return () => {
      alive = false;
    };
  }, []);

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
      // 移动端的播放 owner 是系统媒体服务，不让 Web Audio 再开第二条输出链。
      // DJ 保留在桌面适配器，等 Rust 双 Deck 达到功能等价后再切移动端。
      if (mobileNative) return false;
      // 在线试听没有 BPM/波形，接歌过渡意义不大，硬切更稳
      if (isStreamTrack(next) || isStreamTrack(from)) return false;
      const { enabled, transitions, effects, bars, vocalCut, applyInOutPoints } =
        useDjConfig.getState();
      if (!enabled) return false;
      const outgoingIndex = visualActiveIndexRef.current;
      if (
        !djEngine.begin(next, {
          transitions,
          effects,
          from,
          bars,
          vocalCut,
          applyInOutPoints,
        })
      )
        return false;
      const incomingIndex: 0 | 1 = outgoingIndex === 0 ? 1 : 0;
      const visual = { outgoingIndex, incomingIndex, from, next };
      transitionVisualRef.current = visual;
      setTransitionVisual(visual);
      showTrackDetail();
      djViaRef.current = next.id;
      setFrontEl(djEngine.frontElement());
      setTrack(next);
      selectTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      commitPlaying(true);
      setNotice("");
      markPlayed(next.id);
      return true;
    },
    [mobileNative, selectTrack, showTrackDetail, commitPlaying],
  );

  // 曲库表格双击 / 在线试听 → 这里换曲并播放。用全局事件而不是共享 store，
  // 是为了让"能触发播放"的组件不必都知道播放器的存在。
  useEffect(() => {
    const onPlay = (event: Event) => {
      const parsed = parsePlayRequest((event as CustomEvent).detail);
      if (!parsed) return;
      const next = parsed.track;
      const autoPlay = parsed.autoPlay !== false;
      // PLAY_EVENT 通常由双击/右键等用户手势同步发出。趁手势仍有效唤醒
      // 刷新后 suspended 的 Web Audio 图，否则 audio 在走、扬声器却是静音。
      if (autoPlay) djEngine.resume();
      // 协同关闭时恢复用户设定的音量；不能写死为满音量覆盖底栏音量条。
      if (!useCrossfade.getState().coplay) djEngine.setVolume(playerVolumeRef.current);
      const isLocalVideo = isVideoTrack(next.format);
      // 本地视频的 LOCAL_VIDEO 已在 playTrack 发出；这里只补面板档的详情栏。
      // 音频：playTrack 已 clear 预览会话；非流媒体仍进曲库详情。
      if (isLocalVideo) {
        if (useVideoPip.getState().mode === "panel" && !isStreamTrack(next)) {
          window.dispatchEvent(new Event(DETAIL_EVENT));
        }
      } else if (!isStreamTrack(next)) {
        // 音频起播只清 overlay，不自动钉右栏详情——空闲保持整页列表
        showTrackDetail();
      }
      // DJ 亮着且正在放别的歌：**所有**播放入口（双击、右键播放、自动续播
      // 挑的下一首）都从当前位置接歌，不硬切。视频预览不走这条事件，不受影响。
      const current = trackRef.current;
      if (
        autoPlay &&
        current &&
        playingRef.current &&
        next.id !== current.id &&
        !isLocalVideo &&
        djSwitchTo(next, current)
      ) {
        return;
      }
      // 详情视频控件再点播放：同一首只需恢复播放，绝不能把进度打回 0。
      if (current && next.id === current.id) {
        if (!isStreamTrack(next)) selectTrack(next);
        commitPlaying(autoPlay);
        if (autoPlay) markPlayed(next.id);
        return;
      }
      setTrack(next);
      // 右侧详情跟着切到正在放的这首。自动续播接下一首时尤其重要——
      // 不跟的话详情栏还停在上一首，用户看着 A 的 BPM 听着 B
      if (!isStreamTrack(next)) selectTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      commitPlaying(autoPlay);
      // 手动点播的也记进"放过了"：不然自动续播会把用户刚听完的那首再接一遍
      if (autoPlay && !isStreamTrack(next)) markPlayed(next.id);
    };
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, [selectTrack, showTrackDetail, djSwitchTo, commitPlaying]);

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

  // 起手点：开关开且有结束点 → 按结束点倒推接歌长度；否则波形估尾段，再不行按长度倒推。
  useEffect(() => {
    djOutroRef.current = { trackId: track?.id ?? -1, at: null };
    if (!track || !djEnabled || isStreamTrack(track)) return;
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
    api
      .waveform(track.id)
      .then((wave) => {
        if (!alive) return;
        const at = findOutroStart(wave, lead);
        djOutroRef.current = { trackId: track.id, at };
      })
      .catch(() => {
        /* 波形拿不到就保持 null——回退按长度倒推 */
      });
    return () => {
      alive = false;
    };
  }, [track?.id, track?.end_ms, djEnabled, djBars, applyInOutPoints]);

  // 放到一首还没分析的歌 → 让它插队分析。去重、和"选中即分析"共享一份
  // 排队记号的逻辑都在 autoAnalyze 里，这里只负责把"在放哪一首"告诉它。
  useEffect(() => {
    if (track) analyzePlaying(track);
  }, [track?.id, track?.analyzed_at]);

  // 换曲：移动端把 source 和锁屏元数据交给系统播放器；桌面仍由 DJ adapter
  // 持有双 deck。两条实现只在这一处选择，其他播放入口不感知平台。
  useEffect(() => {
    if (!track) return;
    if (nativePlayer) {
      if (nativeAdoptedTrackIdRef.current === track.id) {
        nativeAdoptedTrackIdRef.current = null;
        setNotice("");
        return;
      }
      const source = mediaUrlForTrack(track);
      nativeLoadInFlightRef.current = true;
      void nativePlayer
        .load({
          src: source,
          track,
          artworkUrl: isStreamTrack(track)
            ? streamCoverUrl(track)
            : api.coverUrl(track.id, track.modified_at),
        })
        .then((state) => {
          setPosition(state.currentTime);
          setDuration(state.duration || track.duration || 0);
          setNotice("");
        })
        .catch((error: unknown) => {
          commitPlaying(false);
          setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          nativeLoadInFlightRef.current = false;
        });
      return;
    }
    // DJ 接歌换上来的曲：引擎已经装好 src、正按曲线进场，这里再动手
    // 就是把进行到一半的过渡掐断重来
    if (djViaRef.current === track.id) {
      djViaRef.current = null;
      setNotice("");
      return;
    }
    // 硬切歌（双击列表、回上一首）顺手掐掉可能还在进行的过渡：
    // 不掐的话暗处退场那台 deck 还会再响好几秒
    djEngine.releaseDecodedPlayback();
    djEngine.cancel();
    // cancel 可能刚把尚在准备的 shadow deck 定为目标正主，不能继续使用旧闭包里的元素。
    const audio = djEngine.frontElement();
    setFrontEl(audio);
    const source = mediaUrlForTrack(track);
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
    djEngine.prepareSeek(source);
    djEngine.prepareDecodedSeek(track, source);
    setNotice("");
    // 播放只交给下面监听 playing/track 的 effect。这里再 play 一次会在暂停后
    // 双击换曲时形成 load → play → play 竞态，其中一个 AbortError 又把状态停掉。
    // playing 不进依赖：它变化时由下面的 effect 处理，这里只管换曲。
    // frontEl 也不进：它只在 DJ 接歌互换时变，而那条路在上面已经 return 了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, nativePlayer, commitPlaying]);

  // 把用户明确排好的下一首预装进系统播放器。更新队尾只修改 Media3 timeline
  // 的非当前项，不重建正在发声的 MediaSource，因此不会因排队操作产生卡顿。
  useEffect(() => {
    if (!nativePlayer || !track) return;
    const tracks = [
      track,
      ...queueIds
        .filter((id) => id !== track.id)
        .map((id) => queueById[id])
        .filter((item): item is Track => Boolean(item)),
    ];
    void nativePlayer.setQueue(
      tracks.map((item) => ({
        src: mediaUrlForTrack(item),
        track: item,
        artworkUrl: isStreamTrack(item)
          ? streamCoverUrl(item)
          : api.coverUrl(item.id, item.modified_at),
      })),
    ).catch((error: unknown) => {
      setNotice(`后台队列同步失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [nativePlayer, track?.id, queueIds, queueById]);

  useEffect(() => {
    if (!track) return;
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
        djEngine.ensureAudible();
        void djEngine.hardPlay(frontEl).catch((error: unknown) => {
          commitPlaying(false);
          setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } else {
      // 停下要连暗处那台一起按住。cancel/seekAbort 可能同步互换正主，不能再用
      // effect 闭包里的旧 frontEl，否则会把暗台暂停两次、真正正主却继续响。
      djEngine.cancel();
      const currentFront = djEngine.frontElement();
      djEngine.hardPause(currentFront);
      if (currentFront !== frontElRef.current) setFrontEl(currentFront);
    }
  }, [playing, track, frontEl, nativePlayer, commitPlaying]);

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
          void nativePlayer.seek(at);
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
  }, [frontEl, track?.id, nativePlayer, commitPlaying, shouldCommitSeek]);

  // 播放器是同步时钟：视频只在明显漂移时纠偏，避免每个 timeupdate 都 seek
  // 造成画面抖动。播放/暂停/跳转动作仍然双向广播。
  useEffect(() => {
    if (!track) return;
    broadcastMediaSync({
      owner: "player",
      action: playing ? "play" : "pause",
      trackId: track.id,
      // 视频恢复播放时必须从当前唱盘位置继续。省略 position 会被当成 0，
      // 暂停后再播放就会把视频错误拉回 Offset 起点。
      position: nativePlayer?.state().currentTime ?? djEngine.currentTime(frontEl),
    });
  }, [playing, track?.id, frontEl, nativePlayer]);

  // 不做音量控制：这里只是预听，音量交给系统。软件里再放一个滑块只是多一个要照看的东西。

  // ……推子除外：协同播放时预览面板那把交叉推子按等功率曲线分走一部分音量，
  // 协同一关立刻回满。这不是「音量设置」，是混音动作，值也从不落盘。
  useEffect(() => {
    playerVolumeRef.current = playerVolume;
    localStorage.setItem("kd-player-volume", String(playerVolume));
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
      void nativePlayer.seek(0);
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
      if (!track || detail.trackId !== track.id || !Number.isFinite(detail.position)) return;
      const target = Math.max(0, detail.position);
      // 拖动时只更新视觉位置；松手再启动一次真正的媒体跳转。否则每个 pointermove
      // 都会重建 shadow deck / 发 Range 请求，越拖积压越多，看起来像整条波形黏住。
      setPosition(target);
      if (detail.preview) return;
      if (!shouldCommitSeek(track.id, target)) return;
      const generation = ++seekGenerationRef.current;
      broadcastMediaSync({
        owner: "player",
        action: "seek",
        trackId: track.id,
        position: target,
      });
      if (nativePlayer) {
        void nativePlayer.seek(target);
      } else {
        void djEngine
          .seamlessSeek(mediaUrlForTrack(track), target, playingRef.current)
          .then((element) => {
            if (generation !== seekGenerationRef.current) return;
            setFrontEl(element);
          });
      }
    };
    window.addEventListener(SEEK_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [track, nativePlayer, shouldCommitSeek]);

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
      commitPlaying(false);
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, [commitPlaying]);

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

  // 原生播放器即使 WebView 暂停也持续走时钟；回到前台后事件会带回权威状态。
  // ended 仍复用下面那条自动续播规则，避免原生/桌面各维护一套播放模式逻辑。
  useEffect(() => {
    if (!nativePlayer) return;
    void nativePlayer.initialize().catch((error: unknown) => {
      setNotice(`原生播放器初始化失败：${error instanceof Error ? error.message : String(error)}`);
    });
    const unsubscribe = nativePlayer.subscribe((state, previous) => {
      positionRef.current = state.currentTime;
      durationRef.current = state.duration || durationRef.current;
      setPosition(state.currentTime);
      if (state.duration > 0) setDuration(state.duration);

      let current = trackRef.current;
      if (state.trackId !== null && state.trackId !== current?.id) {
        const adopted = useQueueStore.getState().byId[state.trackId];
        if (adopted) {
          nativeAdoptedTrackIdRef.current = adopted.id;
          useQueueStore.getState().remove([adopted.id]);
          trackRef.current = adopted;
          current = adopted;
          setTrack(adopted);
          selectTrack(adopted);
          markPlayed(adopted.id);
          setNotice("");
        }
      }
      if (current) {
        broadcast(state.currentTime);
        broadcastMediaSync({
          owner: "player",
          action: "position",
          trackId: current.id,
          position: state.currentTime,
        });
      }

      if (state.playing && !playingRef.current) commitPlaying(true);
      if (
        state.status === "idle" &&
        previous.playing &&
        !nativeLoadInFlightRef.current &&
        playingRef.current
      ) {
        commitPlaying(false);
      }
      if (state.status === "ended" && previous.status !== "ended") {
        commitPlaying(false);
        frontElRef.current.dispatchEvent(new Event("ended"));
      }
      if (state.status === "error") {
        commitPlaying(false);
        setNotice(state.error || "原生播放器无法播放这个文件");
      }
    });
    const syncAfterResume = () => {
      if (document.visibilityState === "visible") void nativePlayer.refresh();
    };
    document.addEventListener("visibilitychange", syncAfterResume);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", syncAfterResume);
    };
  }, [nativePlayer, broadcast, commitPlaying, selectTrack]);

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
    const id = stepBack();
    if (id === null) return;
    const previous = await trackById(id);
    setCanGoBack(hasPrevious());
    // playTrack 会走 markPlayed，而回退**不该**改写历史——
    // 所以这里绕开它，直接换曲
    if (previous) {
      showTrackDetail();
      setTrack(previous);
      selectTrack(previous); // 同上：详情栏跟着回退
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
      if (!track || !playing || !djEnabled) return false;
      // 已经在挑了就装作接手成功：不挡的话曲末自动触发一秒来四次
      if (djBusyRef.current) return true;
      djBusyRef.current = true;
      try {
        markPlayed(track.id);
        const next = await pickNext(track, manual, predictedRef.current);
        if (!next || next.id === track.id) {
          djGaveUpRef.current = track.id;
          return true;
        }
        if (!djSwitchTo(next, track)) {
          if (useDjConfig.getState().applyInOutPoints) autoInOutCueRef.current = next.id;
          playTrack(next);
        }
        return true;
      } finally {
        djBusyRef.current = false;
      }
    },
    [track, playing, djEnabled, djSwitchTo],
  );

  /** 「下一首」和放完自动续播走同一条路，只是标成 manual：单曲循环下手动按=想换歌。 */
  const goNext = async () => {
    if (!track) return;
    // DJ 预设亮着 → 从当前位置开始接歌。引擎不可用时 djNext 会硬切同一候选，
    // 不会再挑一次导致队列被连续消费。
    // 过渡进行中再按也成立：正主已是新歌，再开一场就是「再往下接一首」。
    if (djEnabled && (await djNext(true))) return;
    markPlayed(track.id);
    const next = await pickNext(track, true, predictedRef.current);
    // 候选池空了就安静停下，不报错——这是锦上添花的功能
    if (next) {
      if (useDjConfig.getState().applyInOutPoints) autoInOutCueRef.current = next.id;
      playTrack(next);
    }
  };

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
    if (!playingRef.current && !nativePlayer) djEngine.resume();
    if (!trackRef.current) {
      const pick = selectedRef.current;
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
      djEngine.ensureAudible();
      const currentFront = djEngine.frontElement();
      if (currentFront !== frontElRef.current) setFrontEl(currentFront);
      void djEngine.hardPlay(currentFront).catch((error: unknown) => {
        commitPlaying(false);
        setNotice(`播放失败：${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      djEngine.cancel();
      const currentFront = djEngine.frontElement();
      if (currentFront !== frontElRef.current) setFrontEl(currentFront);
      djEngine.hardPause(currentFront);
    }
    commitPlaying(nextPlaying);
  }, [nativePlayer, commitPlaying]);

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
    togglePlay: toggleTransport,
    seekBy,
    nudgeVolume: (delta) => {
      setPlayerVolume((value) => Math.min(1, Math.max(0, value + delta)));
    },
    goNext: () => {
      void goNext();
    },
    goPrevious: () => {
      void goPrevious();
    },
  });

  /**
   * <audio> 的事件监听挂在"当前正主"元素上。接歌互换正主后这个 effect
   * 随 frontEl 重跑，监听自动搬家——旧 deck 在暗处退场时的 timeupdate /
   * ended 不会再打进 UI。这也是不再用 JSX 渲染 <audio> 的代价与回报。
   */
  useEffect(() => {
    const audio = frontEl;
    const onTime = () => {
      // 主按钮进入“暂停”状态后，媒体还会继续运行半秒来完成淡出。播放头必须
      // 跟到真正的 pause 点；若在这段时间丢弃 timeupdate，UI 会停在旧位置，
      // 下一次播放收到首个 timeupdate 时就会把这半秒一次性补跳出来。
      // shadow deck 准备时旧声仍在走，但不能让旧时钟把刚点击的播放头拉回去。
      if (djEngine.isSeeking()) return;
      const seconds = djEngine.currentTime(audio);
      setPosition(seconds);
      broadcast(seconds);
      broadcastMediaSync({
        owner: "player",
        action: "position",
        trackId: track?.id,
        position: seconds,
      });
      // 曲末自动接歌：优先结束点（开关开着时），其次频谱尾段，再按过渡长度倒推。
      // 太短的音频（demo/音效）不接。
      if (!playing || !track) return;
      // 未开 DJ 时：开关开着且有结束点 → 到点硬切下一首。
      if (
        !djEnabled &&
        applyInOutPoints &&
        track.end_ms != null &&
        seconds >= track.end_ms / 1000 &&
        !djBusyRef.current
      ) {
        djBusyRef.current = true;
        markPlayed(track.id);
        void pickNext(track, false, predictedRef.current)
          .then((next) => {
            if (!next) {
              commitPlaying(false);
              return;
            }
            if (next.id === track.id) {
              const cueSec =
                applyInOutPoints && track.cue_ms != null ? track.cue_ms / 1000 : 0;
              if (nativePlayer) {
                void nativePlayer.seek(cueSec).then(() => nativePlayer.play());
              } else {
                audio.currentTime = cueSec;
                void audio.play();
              }
              setPosition(cueSec);
              return;
            }
            autoInOutCueRef.current = applyInOutPoints ? next.id : null;
            playTrack(next);
          })
          .finally(() => {
            djBusyRef.current = false;
          });
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
      const due =
        outro.trackId === track.id && outro.at !== null
          ? seconds >= outro.at
          : remain <= djEngine.leadSeconds(track.bpm, djBars);
      if (
        due &&
        !djBusyRef.current &&
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
    };
    const onEnded = () => {
      // DJ 正在准备下一首（挑歌请求还没回来）：别和它抢着挑，
      // 过渡开始后正主就换了，这条 ended 也就到不了这里
      if (djBusyRef.current) return;
      setPosition(0);
      // 自动续播：按播放模式挑下一首接上（见 lib/playMode.ts）。
      // 先把"当前这首放完了"记下来再挑，否则它自己会出现在候选里。
      const finished = track;
      if (!finished) {
        commitPlaying(false);
        return;
      }
      // 在线试听没有曲库邻居可接，放完就停
      if (isStreamTrack(finished)) {
        commitPlaying(false);
        return;
      }
      markPlayed(finished.id);
      void pickNext(finished, false, predictedRef.current).then((next) => {
        if (!next) {
          // 候选池空了（曲库太小 / 都放过了）就安静停下，不报错
          commitPlaying(false);
          return;
        }
        // 单曲循环挑回了自己：走 playTrack 的话 track.id 没变，
        // 换 src 的 effect 不会重跑，音频会停在 ended 上不动——直接倒带重放
        if (next.id === finished.id) {
          const cueSec =
            useDjConfig.getState().applyInOutPoints && finished.cue_ms != null
              ? finished.cue_ms / 1000
              : 0;
          if (nativePlayer) {
            void nativePlayer.seek(cueSec).then(() => nativePlayer.play());
          } else {
            audio.currentTime = cueSec;
            void audio.play();
          }
          setPosition(cueSec);
          return;
        }
        // 走和双击列表同一条路：播放器不必知道谁触发了播放
        autoInOutCueRef.current = useDjConfig.getState().applyInOutPoints
          ? next.id
          : null;
        playTrack(next);
      });
    };
    const onError = () => {
      if (track) {
        commitPlaying(false);
        setNotice("这个文件放不了，可能已被移动，或者格式浏览器不支持");
      }
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [frontEl, track, playing, djEnabled, djBars, applyInOutPoints, broadcast, djNext, nativePlayer, commitPlaying]);

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
    return streaming
      ? streamCoverUrl(displayTrack)
      : api.coverUrl(displayTrack.id, displayTrack.modified_at);
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
              : pipMode === "panel"
                ? "右栏预览"
                : "浮动预览"
            : "视频"
          : streaming
            ? "在线试听"
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

  // 当前曲、播放模式、有效范围或点歌队列一变，就给空闲 deck 做一次只读预测。
  // 不在请求起手时清空旧结果：即使后端需要几百毫秒，唱盘也不会先灰再亮。
  // 依赖只放真正参与算法的值，单击无关文件夹/列表不会重跑，这是“下一首闪动”的根因修复。
  useEffect(() => {
    const base = predictionBase;
    if (!base || isStreamTrack(base)) {
      predictedRef.current = null;
      setPredicted(null);
      return;
    }
    // 首次进入先原样保留上次的另一台唱盘；真正换曲/改模式后再重新预测。
    const hasQueuedOverride = queueIds.some((id) => id !== base.id);
    if (!track && !hasQueuedOverride && retainedNextTrack && retainedNextTrack.id !== base.id) {
      predictedRef.current = retainedNextTrack;
      setPredicted(retainedNextTrack);
      return;
    }
    let alive = true;
    void previewNext(base).then((next) => {
      if (!alive) return;
      predictedRef.current = next;
      setPredicted(next);
    });
    return () => {
      alive = false;
    };
  }, [
    predictionBase?.id,
    retainedNextTrack?.id,
    mode,
    scope,
    predictionFolder,
    predictionSort,
    predictionOrder,
    queueIds,
    queueById,
    pipDriving,
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
  const deckPlaying = pipDriving && pipSession?.source === "network" ? pipPlaying : playing;
  const playbackPosition = pipDriving ? pipPosition : position;
  // 音频元数据尚未加载（例如恢复上次的唱盘）时，曲库已有的时长仍应先显示；
  // 否则波形都在却只剩一串 --:--，看不出整首还有多久。
  const playbackDuration = pipDriving ? pipDuration : duration || displayTrack?.duration || 0;
  const remaining = Math.max(0, playbackDuration - playbackPosition);
  // 随机播放的右唱盘只是预告，不必先切走正在放的歌才能换一个候选。
  // 点歌队列是明确的用户意图，永远不在这里提供"换一首"来跳过它。
  const canRefreshPrediction =
    mode === "shuffle" &&
    scope !== "queue" &&
    Boolean(predictionBase) &&
    Boolean(predicted) &&
    !isStreamTrack(predictionBase);
  const refreshPrediction = async () => {
    const base = predictionBase;
    if (!base || refreshingPrediction) return;
    setRefreshingPrediction(true);
    try {
      const excluded = new Set<number>([base.id]);
      if (predictedRef.current) excluded.add(predictedRef.current.id);
      const next = await previewNext(base, false, excluded);
      // 候选已经没有别首可换时保留眼前这首，不把右唱盘无故清空。
      if (next) {
        predictedRef.current = next;
        setPredicted(next);
      }
    } finally {
      setRefreshingPrediction(false);
    }
  };

  // 两台唱盘及正主方向跨会话保留。网络试听没有稳定的曲库 id，不写进存档。
  useEffect(() => {
    if (transitionShowing) return;
    const leftId = leftDeckView?.track && !isStreamTrack(leftDeckView.track)
      ? leftDeckView.track.id
      : deckMemoryRef.current.leftId;
    const rightId = rightDeckView?.track && !isStreamTrack(rightDeckView.track)
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

  const openDeck = (view: PlayerDeckView | null) => {
    const deckTrack = view?.track;
    if (!deckTrack || isStreamTrack(deckTrack)) return;
    selectTrack(deckTrack);
    window.dispatchEvent(
      new CustomEvent(DETAIL_EVENT, { detail: { source: "player-deck" } }),
    );
  };

  const dropOnDeck = async (
    event: React.DragEvent<HTMLButtonElement>,
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
    useQueueStore.getState().replaceNext(first, trackRef.current?.id);
    setNotice(`下一首已替换为：${first.title || first.filename}`);
  };

  const deckDragOver = (
    event: React.DragEvent<HTMLButtonElement>,
    side: "left" | "right",
  ) => {
    if (!isTrackDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDeckDropSide(side);
  };

  return (
    <div className="kd-player" data-pip={pipDriving ? "true" : undefined}>
      {/* 这里不再渲染 <audio>：播放元素归 djEngine 所有（两台 deck 互换正主），
          事件监听在上面的 effect 里挂到 frontEl 上 */}
      {/* 不再挂隐藏视频实例：详情面板已有可见播放器，双实例会同时解码并
          互相回传 seek，画面就一卡一卡。音频是主时钟，打开详情时再对齐即可。 */}

      <div className="kd-player-leading">
        <PlayerDeck
          side="left"
          view={leftDeckView}
          active={visualActiveIndex === 0}
          spinning={Boolean(leftDeckView) && (transitionShowing || (visualActiveIndex === 0 && deckPlaying))}
          transitioning={transitionShowing}
          dropActive={deckDropSide === "left"}
          onOpen={() => openDeck(leftDeckView)}
          onDragOver={(event) => deckDragOver(event, "left")}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDeckDropSide(null);
          }}
          onDrop={(event) => void dropOnDeck(event, "left")}
        />
      </div>
      <InlineNotice text={notice} onDismiss={() => setNotice("")} />

      {/* 三颗走带键：上一首 / 播放停止 / 下一首。
          全是裸图标，没有按钮框——一条播放条上摆三个描边方块太吵，
          而且它们本来就在同一组里，靠间距分得开。 */}
      <div className="kd-player-transport">
        <div className="kd-player-transport-side" data-side="left">
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
                setPlayerVolume(0);
              } else {
                setPlayerVolume(volumeBeforeMuteRef.current || 1);
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
            onChange={(event) => setPlayerVolume(Number(event.currentTarget.value))}
          />
        </label>
        {/* 接播拆成两个动作：Blend 只开关，旁边的调节图标只开设置。
            开关和设置绑在一颗键上时，“只是想看看参数”也会误改播放行为。 */}
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
            className="kd-player-step kd-player-djsettings"
            aria-label="打开接播设置"
            aria-expanded={showSettings}
            data-open={showSettings ? "true" : undefined}
            title="接播设置"
            onClick={openSettingsPanel}
          >
            <SlidersHorizontal size={13} />
          </button>
        </div>

        {/* 搜索页 / 视频预览 / 本地视频：显示模式键。点一下立刻搬家（见 cycleMode → APPLY）。 */}
        {(listMode === "search" || video || pipActive) && (
          <button
            type="button"
            className="kd-player-step kd-player-pip"
            aria-label={`视频预览：${pipModeUi.label}`}
            data-mode={pipMode}
            data-live={pipDriving ? "true" : undefined}
            title={`${pipModeUi.label}：${pipModeUi.hint}。点一下切换右栏 / 浮动小窗`}
            onClick={() => {
              cyclePipMode();
            }}
          >
            <PipModeIcon size={14} />
          </button>
        )}

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
          disabled={!track && !selected && !pipDriving}
          title={
            pipDriving && pipSession?.source === "network"
              ? "播放 / 暂停预览（空格）"
              : "播放 / 暂停（空格）"
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // 走带键按下就生效，不等 pointerup 后的 click；触摸、鼠标长按时都不会
            // 多拖几十到几百毫秒才停声。preventDefault 同时避免随后再合成一次 click。
            event.preventDefault();
            toggleTransport();
          }}
          onClick={(event) => {
            // 键盘激活没有 pointerdown，detail=0；鼠标/触摸已在上面处理，不能执行两次。
            if (event.detail === 0) toggleTransport();
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
          disabled={!track}
          onClick={() => void goNext()}
        >
          <SkipForward size={15} fill="currentColor" />
        </button>

        {/* 播放模式 + 范围，紧挨走带键：它们改的就是"下一首是谁"。
            各一颗按钮循环切换，图标即状态——模式是四选一（调性/顺序/随机/单曲循环），
            范围是三选一（全库/当前文件夹/临时列表）。范围复用详情栏「接歌范围」那个开关，
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
              : scope === "queue"
                ? "范围：临时列表"
                : "范围：全部曲库"
          }
          title={
            scope === "folder"
              ? "只在当前文件夹里挑下一首。点一下改成临时列表"
              : scope === "queue"
                ? "只播放临时列表，队列放空后停止。点一下改成全部曲库"
                : "在全部曲库里挑下一首。点一下改成只在当前文件夹里挑"
          }
          onClick={() => setScope(scope === "all" ? "folder" : scope === "folder" ? "queue" : "all")}
        >
          {scope === "folder" ? (
            <FolderOpen size={14} />
          ) : scope === "queue" ? (
            <ListMusic size={14} />
          ) : (
            <Library size={14} />
          )}
        </button>
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
        <PlayerDeck
          side="right"
          view={rightDeckView}
          active={visualActiveIndex === 1}
          spinning={Boolean(rightDeckView) && (transitionShowing || (visualActiveIndex === 1 && deckPlaying))}
          transitioning={transitionShowing}
          dropActive={deckDropSide === "right"}
          onOpen={() => openDeck(rightDeckView)}
          onDragOver={(event) => deckDragOver(event, "right")}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDeckDropSide(null);
          }}
          onDrop={(event) => void dropOnDeck(event, "right")}
        />
      </div>

      <div className="kd-player-scrub">
        {/* 本地视频预览：曲库里有分析波形就继续用波形；网络预览没有预计算波形，才退回细进度条。
            在线试听同理用细条。普通曲库播放上分析波形。 */}
        <div className="kd-player-wave-stage">
          {pipDriving && pipSession?.source === "local" ? (
          <Waveform
            className="kd-player-wave"
            trackId={pipSession.trackId}
            position={pipPosition}
            duration={pipDuration}
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
            position={track?.id === displayTrack.id ? position : 0}
            duration={track?.id === displayTrack.id ? playbackDuration : (displayTrack.duration ?? 0)}
            cueMs={selected?.id === displayTrack.id ? selected.cue_ms : displayTrack.cue_ms}
            endMs={selected?.id === displayTrack.id ? selected.end_ms : displayTrack.end_ms}
            height={42}
            dimPlayed
            onSetPoint={track?.id === displayTrack.id ? async (kind, at) => {
              const cueMs = selected?.id === track.id ? selected.cue_ms : track.cue_ms;
              const endMs = selected?.id === track.id ? selected.end_ms : track.end_ms;
              const patch = pointPatch(kind, at, cueMs, endMs);
              if (typeof patch === "string") return patch;
              const next = await updateTrack(track.id, patch);
              setTrack(next);
            } : undefined}
          />
        ) : track && streaming ? (
          <div
            className="kd-player-wave-stream"
            role="slider"
            aria-label="试听进度"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={position}
            onClick={(event) => {
              if (duration <= 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const at = ((event.clientX - rect.left) / rect.width) * duration;
              if (nativePlayer) void nativePlayer.seek(at);
              else frontEl.currentTime = at;
              setPosition(at);
            }}
          >
            <span
              className="kd-player-wave-stream-fill"
              style={{ width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%` }}
            />
          </div>
        ) : (
          <div className="kd-player-wave-idle" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
