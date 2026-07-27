import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Blend,
  Clapperboard,
  Disc3,
  FolderOpen,
  Library,
  ListMusic,
  Music2,
  Moon,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Sun,
  Waypoints,
} from "lucide-react";
import { api } from "../../lib/api";
import { analyzePlaying } from "../../lib/autoAnalyze";
import { hasPrevious, markPlayed, pickNext, stepBack, trackById } from "../../lib/autoplay";
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
import { formatDuration, isVideoTrack } from "../../lib/format";
import {
  MEDIA_SYNC_EVENT,
  broadcastMediaSync,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import type { Track } from "../../types";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { InlineNotice } from "../common";
import { POSITION_EVENT, type PositionDetail } from "../library/TrackDetail";
import { DETAIL_EVENT, PLAY_EVENT, playTrack } from "../library/TrackTable";
import { SEEK_EVENT, Waveform, type SeekDetail } from "../library/Waveform";

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
      const over = box.scrollWidth - box.clientWidth;
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

export function PlayerBar() {
  const selected = useLibraryStore(selectSelectedTrack);
  const selectTrack = useLibraryStore((state) => state.selectTrack);
  const mode = usePlayMode((state) => state.mode);
  const cycleMode = usePlayMode((state) => state.cycleMode);
  const scope = useHarmonicScope((state) => state.scope);
  const setScope = useHarmonicScope((state) => state.setScope);
  const coplay = useCrossfade((state) => state.coplay);
  const fadeX = useCrossfade((state) => state.x);
  const djEnabled = useDjConfig((state) => state.enabled);
  const djTransitions = useDjConfig((state) => state.transitions);
  const djBars = useDjConfig((state) => state.bars);
  const toggleDjEnabled = useDjConfig((state) => state.toggleEnabled);
  const showDjPanel = useAppStore((state) => state.showDjPanel);
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const openDjPanel = useAppStore((state) => state.openDjPanel);
  const theme = useAppStore((state) => state.settings?.theme ?? "dark");
  const saveSettings = useAppStore((state) => state.saveSettings);
  const resolvedTheme =
    theme === "system" ? (document.documentElement.dataset.theme ?? "dark") : theme;
  const isDark = resolvedTheme !== "light";
  /**
   * 播放元素归 djEngine 所有——它手里有两台 deck，接歌时互换正主，
   * 这里只拿"当前正主"。不再自己渲染 <audio>：JSX 里的元素没法互换，
   * 换正主就得换 src，中间必有一声可闻的断口。
   */
  const [frontEl, setFrontEl] = useState<HTMLAudioElement>(() => djEngine.frontElement());
  const lastBroadcast = useRef(0);
  /** DJ 接歌换上来的曲目 id：换 src 的 effect 见到它就跳过（引擎已装好）。 */
  const djViaRef = useRef<number | null>(null);
  /** 正在挑歌/起手。曲末的自动触发一秒能来四次，不挡会叠出一摞过渡。 */
  const djBusyRef = useRef(false);
  /** 这首歌自动接歌挑不到候选：记下来别每次 timeupdate 都去问一遍后端。 */
  const djGaveUpRef = useRef<number | null>(null);
  /**
   * 起手时机=「找器乐段」时，这首歌预先算出的起手点（秒）。
   * null = 没算出来（没波形/判不出人声退场），回退按长度倒推。
   */
  const djOutroRef = useRef<{ trackId: number; at: number | null }>({ trackId: -1, at: null });

  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  /**
   * 放不出来的原因写在曲名底下。播放条是"现在在放什么"的唯一显示，
   * 按下播放却没有声音时，人的眼睛就在这里——错误理应也在这里。
   */
  const [notice, setNotice] = useState("");

  // 给 [] 依赖的 PLAY_EVENT 监听读的镜像：拦截接歌要知道"现在在放谁"
  const trackRef = useRef<Track | null>(null);
  const playingRef = useRef(false);
  useEffect(() => {
    trackRef.current = track;
  }, [track]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  /**
   * DJ 过渡切到 next：引擎起手 + UI 立即切过去。返回 false = 引擎没接手
   * （预设关着 / 引擎不可用），调用方走硬切。
   *
   * UI 在过渡**开始**时就切而不是结束时切：换歌的人想看的是接进来的那首；
   * 旧歌在暗处按曲线退场，标题、波形、进度都已经是新歌的了。
   */
  const djSwitchTo = useCallback(
    (next: Track, from: Track): boolean => {
      const { enabled, transitions, effects, bars, vocalCut } = useDjConfig.getState();
      if (!enabled) return false;
      if (!djEngine.begin(next, { transitions, effects, from, bars, vocalCut })) return false;
      showTrackDetail();
      djViaRef.current = next.id;
      setFrontEl(djEngine.frontElement());
      setTrack(next);
      selectTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      setPlaying(true);
      setNotice("");
      markPlayed(next.id);
      return true;
    },
    [selectTrack, showTrackDetail],
  );

  // 曲库表格双击 → 这里换曲并播放。用全局事件而不是共享 store，
  // 是为了让"能触发播放"的组件不必都知道播放器的存在。
  useEffect(() => {
    const onPlay = (event: Event) => {
      const next = (event as CustomEvent<Track>).detail;
      showTrackDetail();
      // DJ 亮着且正在放别的歌：**所有**播放入口（双击、右键播放、自动续播
      // 挑的下一首）都从当前位置接歌，不硬切。视频预览不走这条事件，不受影响。
      const current = trackRef.current;
      if (current && playingRef.current && next.id !== current.id && djSwitchTo(next, current)) {
        return;
      }
      setTrack(next);
      // 右侧详情跟着切到正在放的这首。自动续播接下一首时尤其重要——
      // 不跟的话详情栏还停在上一首，用户看着 A 的 BPM 听着 B
      selectTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      setPlaying(true);
      // 手动点播的也记进"放过了"：不然自动续播会把用户刚听完的那首再接一遍
      markPlayed(next.id);
    };
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, [selectTrack, showTrackDetail, djSwitchTo]);

  // 起手点完全自动：优先按波形估计结尾器乐段；判断不出时按接歌长度倒推。
  useEffect(() => {
    djOutroRef.current = { trackId: track?.id ?? -1, at: null };
    if (!track || !djEnabled) return;
    let alive = true;
    api
      .waveform(track.id)
      .then((wave) => {
        if (!alive) return;
        const at = findOutroStart(wave, mixSeconds(track.bpm, djBars));
        djOutroRef.current = { trackId: track.id, at };
      })
      .catch(() => {
        /* 波形拿不到就保持 null——回退按长度倒推 */
      });
    return () => {
      alive = false;
    };
  }, [track?.id, djEnabled, djBars]);

  // 放到一首还没分析的歌 → 让它插队分析。去重、和"选中即分析"共享一份
  // 排队记号的逻辑都在 autoAnalyze 里，这里只负责把"在放哪一首"告诉它。
  useEffect(() => {
    if (track) analyzePlaying(track);
  }, [track?.id, track?.analyzed_at]);

  // 换曲：换 src 后必须 load()，否则 Chromium 会继续放上一首的缓冲
  useEffect(() => {
    if (!track) return;
    // DJ 接歌换上来的曲：引擎已经装好 src、正按曲线进场，这里再动手
    // 就是把进行到一半的过渡掐断重来
    if (djViaRef.current === track.id) {
      djViaRef.current = null;
      setNotice("");
      return;
    }
    // 硬切歌（双击列表、回上一首）顺手掐掉可能还在进行的过渡：
    // 不掐的话暗处退场那台 deck 还会再响好几秒
    djEngine.cancel();
    const audio = frontEl;
    audio.src = api.audioUrl(track.id);
    audio.load();
    setNotice("");
    if (playing) {
      audio.play().catch((error: unknown) => {
        setPlaying(false);
        setNotice(`播放失败：${(error as Error).message}`);
      });
    }
    // playing 不进依赖：它变化时由下面的 effect 处理，这里只管换曲。
    // frontEl 也不进：它只在 DJ 接歌互换时变，而那条路在上面已经 return 了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  useEffect(() => {
    if (!track) return;
    if (playing) {
      frontEl.play().catch(() => setPlaying(false));
    } else {
      // 停下要连暗处那台一起按住：过渡进行到一半按停止，
      // 只停正主的话退场中的旧歌还会自己淡完那几秒
      djEngine.cancel();
      frontEl.pause();
    }
  }, [playing, track, frontEl]);

  // 视频可以从自己的控件发出播放/暂停/跳转；协同预览没有 trackId，
  // 本地视频则必须只接收当前曲目的消息，避免详情切换后误控旧视频。
  useEffect(() => {
    const onMediaSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner === "player") return;
      if (detail.owner === "preview" && !useCrossfade.getState().coplay) return;
      if (detail.owner === "local-video" && detail.trackId !== track?.id) return;
      if (!track) return;
      if (detail.action === "play") {
        setPlaying(true);
      } else if (detail.action === "pause") {
        setPlaying(false);
      } else if (detail.action === "seek" && detail.position !== undefined) {
        frontEl.currentTime = Math.max(0, detail.position);
        setPosition(frontEl.currentTime);
        broadcastMediaSync({
          owner: "player",
          action: "seek",
          trackId: track.id,
          position: frontEl.currentTime,
        });
      }
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onMediaSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onMediaSync);
  }, [frontEl, track?.id]);

  // 播放器是同步时钟：视频只在明显漂移时纠偏，避免每个 timeupdate 都 seek
  // 造成画面抖动。播放/暂停/跳转动作仍然双向广播。
  useEffect(() => {
    if (!track) return;
    broadcastMediaSync({
      owner: "player",
      action: playing ? "play" : "pause",
      trackId: track.id,
    });
  }, [playing, track?.id]);

  // 不做音量控制：这里只是预听，音量交给系统。软件里再放一个滑块只是多一个要照看的东西。

  // ……推子除外：协同播放时预览面板那把交叉推子按等功率曲线分走一部分音量，
  // 协同一关立刻回满。这不是「音量设置」，是混音动作，值也从不落盘。
  useEffect(() => {
    // 两台 deck 一起设：接歌中途拨推子，暗处退场那台也要跟着小
    djEngine.setVolume(deckGain(coplay, fadeX));
  }, [coplay, fadeX]);

  // 拨开协同播放（epoch +1）= 「两边同时从头来」：唱盘倒回 0 起播，
  // 预览那侧按 Offset 自己对位。不从头对齐的话，两条时间线的相对位置
  // 全看拨开关那一刻的手气，校出来的 Offset 毫无意义。
  // 协同关掉时不动唱盘——关推子的人多半正听着唱盘这一侧。
  const fadeEpoch = useCrossfade((state) => state.epoch);
  useEffect(() => {
    if (fadeEpoch === 0 || !track) return; // 0 = 还没开过协同
    frontEl.currentTime = 0;
    setPosition(0);
    broadcastMediaSync({ owner: "player", action: "seek", trackId: track.id, position: 0 });
    setPlaying(true);
    // track 不进依赖：只在拨开关那一下重启，换歌不该再从头来一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeEpoch]);

  // 详情页点波形跳转
  useEffect(() => {
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<SeekDetail>).detail;
      if (!track || detail.trackId !== track.id) return;
      frontEl.currentTime = detail.position;
      setPosition(detail.position);
      broadcastMediaSync({
        owner: "player",
        action: "seek",
        trackId: track.id,
        position: detail.position,
      });
    };
    window.addEventListener(SEEK_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [track, frontEl]);

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
      setPlaying(false);
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

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
      setPlaying(true);
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
        const next = await pickNext(track, manual);
        if (!next || next.id === track.id) {
          djGaveUpRef.current = track.id;
          return true;
        }
        if (!djSwitchTo(next, track)) playTrack(next);
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
    const next = await pickNext(track, true);
    // 候选池空了就安静停下，不报错——这是锦上添花的功能
    if (next) playTrack(next);
  };

  /**
   * <audio> 的事件监听挂在"当前正主"元素上。接歌互换正主后这个 effect
   * 随 frontEl 重跑，监听自动搬家——旧 deck 在暗处退场时的 timeupdate /
   * ended 不会再打进 UI。这也是不再用 JSX 渲染 <audio> 的代价与回报。
   */
  useEffect(() => {
    const audio = frontEl;
    const onTime = () => {
      const seconds = audio.currentTime;
      setPosition(seconds);
      broadcast(seconds);
      broadcastMediaSync({
        owner: "player",
        action: "position",
        trackId: track?.id,
        position: seconds,
      });
      // 曲末自动接歌：优先从频谱判出的尾段起手，判不出就按过渡长度倒推。
      // 太短的音频（demo/音效）不接。
      if (!djEnabled || !playing || !track) return;
      const total =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : (track.duration ?? 0);
      if (total < 30) return;
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
        setPlaying(false);
        return;
      }
      markPlayed(finished.id);
      void pickNext(finished).then((next) => {
        if (!next) {
          // 候选池空了（曲库太小 / 都放过了）就安静停下，不报错
          setPlaying(false);
          return;
        }
        // 单曲循环挑回了自己：走 playTrack 的话 track.id 没变，
        // 换 src 的 effect 不会重跑，音频会停在 ended 上不动——直接倒带重放
        if (next.id === finished.id) {
          audio.currentTime = 0;
          void audio.play();
          return;
        }
        // 走和双击列表同一条路：播放器不必知道谁触发了播放
        playTrack(next);
      });
    };
    const onError = () => {
      if (track) {
        setPlaying(false);
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
  }, [frontEl, track, playing, djEnabled, djBars, broadcast, djNext]);

  // 跳转统一由 Waveform 发 kd:seek 事件，上面那个监听负责落到 <audio> 上

  // 在放的优先；没在放就显示曲库里选中的那首（按下播放键放的就是它）
  const titleText = track
    ? track.title || track.filename
    : selected
      ? selected.title || selected.filename
      : "没有在播的曲目";
  // 没有艺人时垫一个 nbsp 而不是空串：空内容不产生行盒，第二行会塌掉，
  // 换到一首没艺人的歌整条播放条的字就往下跳一下
  const displayTrack = track ?? selected;
  const video = Boolean(displayTrack && isVideoTrack(displayTrack.format));
  const artistText = displayTrack?.artist || "\u00a0";

  return (
    <div className="kd-player">
      {/* 这里不再渲染 <audio>：播放元素归 djEngine 所有（两台 deck 互换正主），
          事件监听在上面的 effect 里挂到 frontEl 上 */}

      <div className="kd-player-leading">
        {/* 只留一颗裸图标：无块状底、无边框、无分割线。 */}
        <button
          type="button"
          className="kd-player-theme"
          aria-label={isDark ? "切到日间模式" : "切到夜间模式"}
          title={isDark ? "日间模式" : "夜间模式"}
          onClick={() => void saveSettings({ theme: isDark ? "light" : "dark" })}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

      {/* 「正在播」块：封面 + 曲名/艺人。点它 = 让详情回到正在放的这首——
          听着听着翻远了，一下就能回来。竖屏没有右栏，这一下还兼职"拉开详情抽屉"
          （DETAIL_EVENT 由 Workspace 接住）：列表里点一下已经让给了播放，
          详情的入口就挪到这儿——想看哪首的详情，先放它，再点这块。
          唱片占位常驻：没有它的话换歌时封面会"啪"地冒出来把右边的字挤走。 */}
      <button
        type="button"
        className="kd-player-now"
        disabled={!track}
        title={track ? "查看正在播放的曲目" : undefined}
        onClick={() => {
          if (!track) return;
          selectTrack(track);
          window.dispatchEvent(new Event(DETAIL_EVENT));
        }}
      >
        <span className="kd-player-disc" data-empty={!track ? "true" : undefined} aria-hidden="true">
          {track ? (
            <>
              <Disc3 size={18} />
              <img
                src={api.coverUrl(track.id)}
                alt=""
                onError={(event) => {
                  event.currentTarget.style.opacity = "0";
                }}
                onLoad={(event) => {
                  event.currentTarget.style.opacity = "1";
                }}
              />
            </>
          ) : (
            <Music2 size={16} />
          )}
        </span>
        {/* 两行都走 MarqueeText：曲名再长也只能在这个盒子里滚，
            越不过右边的播放键——那是这条上唯一的动作，绝不能被字盖住 */}
        <span className="kd-player-meta" data-notice={notice ? "true" : undefined}>
          <MarqueeText className="kd-player-title" text={titleText} />
          {/* 视频通常没有艺人，因此第二行改成明确的视频类型标识；音频仍显示艺人，
              空艺人继续留一行占位，避免切歌时整条文字上下跳。 */}
          {video ? (
            <span className="kd-player-artist kd-player-video-label">
              <Clapperboard size={11} />
              视频
            </span>
          ) : (
            <MarqueeText className="kd-player-artist" text={artistText} />
          )}
        </span>
      </button>
      </div>
      <InlineNotice text={notice} onDismiss={() => setNotice("")} />

      {/* 三颗走带键：上一首 / 播放停止 / 下一首。
          全是裸图标，没有按钮框——一条播放条上摆三个描边方块太吵，
          而且它们本来就在同一组里，靠间距分得开。 */}
      <div className="kd-player-transport">
        {/* DJ 接歌：走带键左边的一颗小按钮。亮着 = 换歌不再硬切，而是把
            下一首 BPM 同步后从当前位置按方案曲线接进来（见 lib/djMix.ts）。
            点它在右侧详情栏开配置面板（DjPanel）——配置项多到弹窗装不下，
            而且这个项目不养弹窗。 */}
        <div className="kd-player-dj">
          <button
            type="button"
            className="kd-player-step kd-player-djbtn"
            aria-label="接播设置"
            aria-pressed={djEnabled}
            aria-expanded={showDjPanel}
            data-on={djEnabled ? "true" : undefined}
            title={
              !djEnabled
                ? "接播设置：关。点一下开启并在右侧配置"
                : `接播设置：${djTransitions
                    .map((id) => DJ_TRANSITIONS.find((item) => item.id === id)?.label)
                    .filter(Boolean)
                    .join(" + ")}，${djBars} 小节。点一下关闭`
            }
            onClick={() => {
              toggleDjEnabled();
              openDjPanel();
            }}
          >
            <Blend size={14} />
          </button>
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

        <button
          type="button"
          className="kd-player-go"
          aria-label={playing ? "停止" : "播放"}
          data-playing={playing ? "true" : undefined}
          disabled={!track && !selected}
          onClick={() => {
            // 还没有在播的曲子时，播的就是曲库里当前选中的那首——
            // 「选中 → 按播放」和双击是等价的两条路。
            if (!track) {
              if (selected) playTrack(selected);
              return;
            }
            if (playing) {
              frontEl.currentTime = 0; // 停止就是回到开头，和图标一致
              if (track) {
                broadcastMediaSync({ owner: "player", action: "seek", trackId: track.id, position: 0 });
              }
            }
            setPlaying((value) => !value);
            if (playing) setPosition(0);
          }}
        >
          {playing ? <Square size={12} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>

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
      </div>

      <div className="kd-player-scrub">
        {/* 进度条就是波形本身：DJ 软件都是这么做的，看一眼就知道下一个 drop 还有多远 */}
        {track ? (
          <Waveform
            className="kd-player-wave"
            trackId={track.id}
            position={position}
            height={38}
            dimPlayed
          />
        ) : (
          /* 空态不复用 kd-player-wave：Waveform 组件的根元素也带这个 class，
             针对空态写的"压成一条细线"会连真波形一起压扁 */
          <div className="kd-player-wave-idle" aria-hidden="true" />
        )}
        <span className="kd-player-time kd-nowrap">
          {formatDuration(position)} / {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}
