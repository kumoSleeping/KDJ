import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { History, LoaderCircle, Music, Sparkles, Video, X } from "lucide-react";
import { AI_DROP_ATTR, fromLocalTracks, fromPastedImage, fromSearchDrag, timeLabel } from "../../lib/aiAttachments";
import { activeSearchDrag, finishSearchDrop, readSearchDrop } from "../../lib/searchDrag";
import { finishTrackDrop, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { useLibraryStore } from "../../stores/libraryStore";
import { aiApi } from "../../lib/api";
import { showTask } from "../tasks/taskBubbleStore";
import { useAiDrawer } from "../../lib/aiDrawer";
import type { AiThinking } from "../../types/ai";
import type { Platform, SearchKind, TrackSummary } from "../../types";
import { aiOffered, useAiStore } from "../../stores/aiStore";
import { useSearchPresets } from "./useSearchPresets";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import {
  DEFAULT_PRIORITY,
  DEFAULT_SEARCH_PLATFORMS,
  normalizePriority,
  normalizeSearchPlatforms,
  SEARCH_PLATFORMS,
} from "../../lib/searchPlatforms";
import { useAppStore } from "../../stores/appStore";
import { MOTION_MICRO_OUT_MS, MOTION_REDUCED_MS, prefersReducedMotion } from "../../lib/motion";
import { PlatformMark } from "./PlatformMark";
import { HintBulbIcon } from "./HintBulbIcon";
import {
  clearSearchOutcome,
  estimateTextEm,
  getSearchOutcome,
  searchMarkState,
  searchTones,
  subscribeSearchOutcome,
  type SearchOutcome,
  type SearchPhase,
} from "./searchMotion";
import "./SearchBar.css";

/** pi's reasoning efforts in the order the key steps through them. */
const THINKING_ORDER: AiThinking[] = ["low", "medium", "high", "xhigh"];
const THINKING_LABEL: Record<AiThinking, string> = { low: "低", medium: "中", high: "高", xhigh: "极高" };
const nextThinking = (level: AiThinking) => THINKING_ORDER[(THINKING_ORDER.indexOf(level) + 1) % THINKING_ORDER.length];

/** One step of the reasoning key: shown at once, kept by kdj-server and given to pi. */
async function cycleThinking(): Promise<void> {
  const ai = useAiStore.getState();
  const status = ai.status;
  if (!status) return;
  const level = nextThinking(status.thinking ?? "high");
  ai.setStatus({ ...status, thinking: level });
  try {
    ai.setStatus(await aiApi.setThinking(level));
  } catch (error) {
    ai.setStatus(status);
    showTask({ id: "ai-thinking", kind: "notice", title: "推理强度没能切换", detail: error instanceof Error ? error.message : String(error), tone: "error", placement: "top" });
  }
}

export {
  DEFAULT_PRIORITY,
  DEFAULT_SEARCH_PLATFORMS,
  normalizeSearchPlatforms,
  SEARCH_PLATFORMS,
};

/** 平台选择那一行单独一个组件（SearchPlatforms），props 也分开列。 */
export interface SearchPlatformProps {
  platforms: Platform[];
  onTogglePlatform(platform: Platform): void;
  /** 顺序与启用都读写 settings.platform_priority：拖动排序就是下载来源的优先级。 */
  /** 手机顶栏的重叠预览；第一次点只展开，不误切来源。 */
  collapsed?: boolean;
  onExpand?: () => void;
  /** A search in flight or just landed: the selected marks wait, then settle on what came back. */
  searchPhase?: SearchPhase | null;
  searchOutcome?: SearchOutcome | null;
}

export interface SearchBarProps extends SearchPlatformProps {
  query: string;
  presetTrack?: TrackSummary | null;
  playingTrack?: TrackSummary | null;
  searchKind: SearchKind;
  searchKinds: readonly SearchKind[];
  onSearchKindChange(kind: SearchKind): void;
  onQueryChange(value: string): void;
  /** 批量模式由输入内容推导（有换行/多条链接），不再有开关按钮。 */
  batch: boolean;
  busy: boolean;
  onSubmit(): void;
  tipsOpen: boolean;
  onTips(): void;
  /** 竖屏/极窄：输入与平台拆成两段。 */
  stacked?: boolean;
  /** A search started outside the field (同名搜索 fills and submits); a new value launches the motion. */
  burstNonce?: number;
}

/** A submit that never raised `busy` (rejected input, a page change) ends the search motion by itself. */
const SEARCH_START_GRACE_MS = 700;
/** The waveform's line is drawn and its bars have risen (SearchBar.css): an answer that beats them waits. */
const SEARCH_RISE_MS = 540;
/** The landing: the waveform settles into its line and the marks settle one after another (SearchBar.css). */
const SEARCH_LANDING_MS = 1000;

/**
 * 在线搜索：左边是搜索类型与来源，右边是输入。
 *
 * 两部分之间不画线：输入区自己是一块浅色底，和来源靠间距分开。
 * 平台键只负责来源多选与顺序；提交靠 Enter（Shift+Enter 换行），不再单独放放大镜。
 *
 * A search is drawn as a waveform under the text, in the selected sources' colours: on Enter a
 * centre line is drawn and bars rise out of it, they keep playing while sources are pending,
 * and they settle back into the line when the results land. Focus only deepens the field's
 * tone, and typing moves nothing but the caret.
 */
const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  song: "单曲",
  playlist: "歌单",
  artist: "艺术家",
  album: "专辑",
  radio: "播客",
};

export const SEARCH_INPUT_TIP = "输入歌名、歌手或链接，按 Enter 开始搜索~";

export const SEARCH_TIPS = [
  "右键侧边栏的文件夹可以设定为下载目录哦~",
  "曲库优化分析可以找出重复歌曲并协助清理！",
  SEARCH_INPUT_TIP,
  "左边这个灯泡是可以点击的哦，你可以试试。",
  "可同时选择多个平台，一次搜索更多来源。",
  "拖动平台图标，可以调整搜索优先级。",
  "粘贴多行歌曲链接，可以批量识别哟。",
  "开发者很喜欢「全金属狂潮」校园篇。",
  "居然有相当一部分用户把 KDJ 作为日常播放器使用诶!",
  "KDJ可以播放视频，甚至可以全屏！（应 DJ BanGo 要求）",
  "DJ BanGo是 KDJ 第一位用户！没有他就没有今天的KDJ！",
  "测试搜索的时候，搜出来的第一个视频是羽月澪的。",
  "搜索/在线歌单可以直接拖动到任意本地板块!",
  "您可以直接在 KDJ 中，从自己的歌单或收藏中移除歌曲！",
  "请不要在社交平台公开传播本软件，谢谢理解！",
  "右键歌曲复制来源链接, 和小程序卡片一样!",
  "如果歌曲没有封面, 详情板块有很多方法补充~",
  "开发者认为「水果篮子」老版比新版好看太多了。",
  "传输键右边有三个开关：自动切歌、歌词和视频小窗！",
  "可通过系统媒体控制快捷键、Android 控制中心或灵动岛操控播放哟~",
  "不喜欢视频小窗？再点一次小窗键就能关掉。",
  "视频支持系统级小窗! 详情界面也有视频播放哟~",
  "为了无缝跳转, 我们实现了一个播放器引擎!",
  "复制粘贴多选快捷键都可用哦, 也可以右键选择。",
  "按 Shift + Enter 可以在搜索框里换行哦～",
  "搜索结果展开后，可以挑选更合适的平台来源！",
  "右键本地歌曲，可以直接在文件夹中显示它。",
  "设置中可以自由切换调性记谱方式！",
  "下载队列中可以单独调整歌曲音质和保存位置！",
  "横屏列表默认双击播放，设置里也能改成单击播放～",
  "右键表头可以选择显示哪些列，拖动表头还能调整顺序！",
  "拖动表头右侧边缘，可以自由调整每一列的宽度。",
  "按 Cmd/Ctrl + Z，可以撤回最近一次复制、移动或删除。",
  "按住 Option/Alt 再粘贴，可以把歌曲移动到目标文件夹！",
  "触屏设备长按歌曲，也能打开和右键相同的菜单～",
  "使用 KDJ 下载的歌曲会自动缓存可用歌词。",
  "悬浮歌词可以拖动位置，也能开启鼠标或触摸穿透！",
  "本地歌曲可以直接拖到软件外，就像从资源管理器里拖文件一样！",
  "点击搜索框左侧的“单曲”，可以切换搜索类型！",
  "部分平台功能需要登录具备相应播放权限的账号才能使用。",
  "详情面板支持同名搜索，可以快速找到同名歌曲！",
  "Control 表头可以切换细节波形，也可以把整个 Control 面板收起来。",
  "可以设置拖拽操作是要分享链接还是文件~",
] as const;

function shuffleTipIndexes(avoidFirst?: number): number[] {
  const indexes = SEARCH_TIPS.map((_, index) => index);
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [indexes[index], indexes[target]] = [indexes[target], indexes[index]];
  }
  if (indexes.length > 1 && indexes[0] === avoidFirst) {
    [indexes[0], indexes[1]] = [indexes[1], indexes[0]];
  }
  return indexes;
}

/**
 * One line of text that changes, by the schema's `turn` — the gesture of the work rail under
 * the field: the old line lifts away, then the new one comes up from below. The two share one
 * clipped line box and are never legible at once, and nothing around them moves. The first
 * line is simply there.
 */
function RollText({ text, className }: { text: string; className?: string }) {
  const [line, setLine] = useState<{ text: string; previous: string | null; turn: number }>({
    text,
    previous: null,
    turn: 0,
  });
  if (line.text !== text) {
    // While the old line is still leaving, the new one has not shown yet: it only gets other words.
    setLine(line.previous === null ? { text, previous: line.text, turn: line.turn + 1 } : { ...line, text });
  }
  return (
    <span className={className ? `kd-roll ${className}` : "kd-roll"}>
      {line.previous !== null && (
        <span
          key={`out:${line.turn}`}
          className="kd-roll-line"
          data-kd-turn="out"
          aria-hidden="true"
          onAnimationEnd={() => {
            setLine((current) => (current.previous === null ? current : { ...current, previous: null }));
          }}
        >
          {line.previous}
        </span>
      )}
      <span
        key={line.turn}
        className="kd-roll-line"
        data-kd-turn={line.turn ? "in" : undefined}
        data-kd-turn-after={line.turn ? "" : undefined}
      >
        {line.text}
      </span>
    </span>
  );
}

function SearchTipCarousel({
  inputFocused,
  tipsOpen,
  onTips,
}: {
  inputFocused: boolean;
  tipsOpen: boolean;
  onTips(): void;
}) {
  const [tipIndex, setTipIndex] = useState(
    () => Math.floor(Math.random() * SEARCH_TIPS.length),
  );
  const [actionFocused, setActionFocused] = useState(false);
  const currentTipRef = useRef(tipIndex);
  const queuedTipsRef = useRef<number[]>([]);

  useEffect(() => {
    // The tips only turn while nobody is at the field: never while it is focused, typed in or composed in.
    if (inputFocused || actionFocused) return;
    const timer = window.setInterval(() => {
      if (queuedTipsRef.current.length === 0) {
        queuedTipsRef.current = shuffleTipIndexes(currentTipRef.current);
      }
      const next = queuedTipsRef.current.shift();
      if (next === undefined) return;
      currentTipRef.current = next;
      setTipIndex(next);
    }, 8000);

    return () => window.clearInterval(timer);
  }, [actionFocused, inputFocused]);

  return (
    <span className="kd-search-placeholder">
      <span
        className="kd-search-tip"
        data-input-focused={inputFocused ? "true" : undefined}
      >
        <button
          type="button"
          className="kd-search-tip-action"
          data-open={tipsOpen ? "true" : undefined}
          tabIndex={inputFocused ? -1 : undefined}
          aria-hidden={inputFocused || undefined}
          aria-label={tipsOpen ? "收起使用提示" : "查看全部使用提示"}
          aria-pressed={tipsOpen}
          title={tipsOpen ? "收起使用提示" : "查看全部使用提示"}
          onFocus={() => setActionFocused(true)}
          onBlur={() => setActionFocused(false)}
          onClick={onTips}
        >
          <HintBulbIcon size={14} aria-hidden="true" />
        </button>
        {/* A focused field says what Enter does; otherwise the tips turn. */}
        <span className="kd-search-tip-copy" aria-hidden="true">
          <RollText text={inputFocused ? SEARCH_INPUT_TIP : SEARCH_TIPS[tipIndex]} />
        </span>
      </span>
    </span>
  );
}

export function SearchBar({
  query,
  presetTrack,
  playingTrack,
  searchKind,
  searchKinds,
  onSearchKindChange,
  onQueryChange,
  batch,
  busy,
  onSubmit,
  tipsOpen,
  onTips,
  stacked = false,
  burstNonce = 0,
  ...platformProps
}: SearchBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const presets = useSearchPresets({ query, onQueryChange, track: presetTrack, playingTrack, inputRef });
  // Some third-party dictation IMEs report Enter before React's isComposing
  // flag settles. Keep our own composition state and also honor keyCode 229.
  const composingRef = useRef(false);
  // AI mode (docs/ai-dock.md): the same field takes a request for the AI. The search's own
  // query is kept and comes back with the mode.
  const offered = aiOffered();
  const aiWanted = useAiStore(state => state.mode) && offered;
  // The whole row turns over between the two modes by the schema's `turn`: the search row
  // lifts away, and the Agent Mode row comes up in its place, laid out at once. The row shows
  // one mode at a time, so what is drawn (`aiMode`) follows the store a gesture later.
  const [aiMode, setAiMode] = useState(aiWanted);
  const [rowTurn, setRowTurn] = useState<"out" | "in" | null>(null);
  if (aiWanted !== aiMode && rowTurn !== "out") setRowTurn("out");
  useEffect(() => {
    if (rowTurn !== "out") return;
    const timer = window.setTimeout(() => {
      setAiMode(useAiStore.getState().mode && offered);
      setRowTurn("in");
    }, prefersReducedMotion() ? MOTION_REDUCED_MS : MOTION_MICRO_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [rowTurn, offered]);
  const aiRunning = useAiStore(state => state.running);
  const attachments = useAiStore(state => state.attachments);
  const resume = useAiStore(state => state.resume);
  const thinking = useAiStore(state => state.status?.thinking ?? "high");
  const [request, setRequest] = useState("");
  const seed = useAiStore(state => state.seed);
  useEffect(() => {
    if (!seed || !offered) return;
    setRequest(seed.text);
    useAiStore.setState({ seed: null });
    inputRef.current?.focus();
  }, [seed, offered]);
  // Turning the mode over puts the caret in the field; arriving on screen does not.
  const modeWas = useRef(aiMode);
  useEffect(() => {
    if (modeWas.current === aiMode) return;
    modeWas.current = aiMode;
    inputRef.current?.focus();
  }, [aiMode]);
  const sendRequest = () => {
    const text = request.trim();
    if (!text) return;
    // Sent, the request leaves the field for its task at the bottom right.
    setRequest("");
    void useAiStore.getState().send(text);
  };
  const [inputFocused, setInputFocused] = useState(false);
  const [platformsExpanded, setPlatformsExpanded] = useState(false);
  const [wavePhase, setWavePhase] = useState<SearchPhase | null>(null);
  /** Counts launches, so each search gets a fresh waveform, and how far its text reaches (em). */
  const [launch, setLaunch] = useState({ seq: 0, textEm: 0 });
  /** When the current waveform set off, and how long a landing waits for it to have risen. */
  const launchedAtRef = useRef(0);
  const [landingHold, setLandingHold] = useState(0);
  const searchOutcome = useSyncExternalStore(subscribeSearchOutcome, getSearchOutcome, getSearchOutcome);
  /** 提交后在等结果：见过 busy=true 之后，busy 落回 false 才收起波形。 */
  const wavePendingRef = useRef(false);
  const waveSawBusyRef = useRef(false);
  const lastNonceRef = useRef(burstNonce);
  const canSubmit = query.trim().length > 0 && !busy;
  // Agent Mode's request grows with its lines like a batch of keywords does: the lines it breaks
  // (Shift + Enter) and the ones a long sentence wraps into, measured from the field itself.
  const shown = aiMode ? request : query;
  const [wrapRows, setWrapRows] = useState(1);
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!aiMode || !element) {
      setWrapRows(1);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(element);
      const leading = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // Collapsed for the measure, the field's scroll height is what its text needs.
      const height = element.style.height;
      element.style.height = "0px";
      const lines = Math.max(1, Math.round((element.scrollHeight - padding) / leading));
      element.style.height = height;
      setWrapRows(current => (current === lines ? current : lines));
    };
    measure();
    // A narrower or wider row wraps the sentence again.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [aiMode, request]);
  const inputRows = aiMode ? Math.min(5, Math.max(1, request.split("\n").length, wrapRows))
    : batch ? Math.min(5, Math.max(2, query.split("\n").length)) : 1;
  const currentKindIndex = searchKinds.indexOf(searchKind);
  const nextSearchKind = searchKinds.length
    ? searchKinds[(Math.max(-1, currentKindIndex) + 1) % searchKinds.length]
    : searchKind;

  // The search's colours: the selected sources' own, in the order of their marks. Set once per
  // selection as --kd-search-tones; the stylesheet has a neutral pair for an empty selection.
  const settingsPriority = useAppStore((state) => state.settings?.platform_priority);
  const markOrder = settingsPriority ?? DEFAULT_PRIORITY;
  const selectedPlatforms = platformProps.platforms;
  const barStyle = useMemo(() => {
    const tones = searchTones(normalizePriority(markOrder), selectedPlatforms);
    return tones.length ? ({ "--kd-search-tones": tones.join(", ") } as CSSProperties) : undefined;
  }, [markOrder, selectedPlatforms]);
  const expandPlatforms = useCallback(() => setPlatformsExpanded(true), []);

  const startWave = () => {
    wavePendingRef.current = true;
    // Explore 代搜时 submit 可能已经把 busy 拉高，这一帧就要算「见过 busy」。
    waveSawBusyRef.current = busy;
    clearSearchOutcome();
    launchedAtRef.current = performance.now();
    // Once per search: the waveform steps back behind this much text (the longest line of a batch).
    const textEm = Math.max(...query.split("\n").map(estimateTextEm));
    setLaunch((current) => ({ seq: current.seq + 1, textEm }));
    setWavePhase("run");
  };
  const landWave = () => {
    wavePendingRef.current = false;
    setLandingHold(Math.max(0, Math.round(SEARCH_RISE_MS - (performance.now() - launchedAtRef.current))));
    setWavePhase("done");
  };

  useEffect(() => {
    if (!wavePendingRef.current) return;
    if (busy) {
      waveSawBusyRef.current = true;
      return;
    }
    // 提交瞬间 busy 还没拉高：先别收。等真正跑完一轮再淡出。
    if (!waveSawBusyRef.current) return;
    landWave();
  }, [busy]);

  useEffect(() => {
    if (wavePhase === "run") {
      const timer = window.setTimeout(() => {
        if (!wavePendingRef.current || waveSawBusyRef.current) return;
        landWave();
      }, SEARCH_START_GRACE_MS);
      return () => window.clearTimeout(timer);
    }
    if (wavePhase === "done") {
      const timer = window.setTimeout(() => setWavePhase(null), landingHold + SEARCH_LANDING_MS);
      return () => window.clearTimeout(timer);
    }
  }, [wavePhase, landingHold]);

  useEffect(() => {
    if (burstNonce === lastNonceRef.current) return;
    lastNonceRef.current = burstNonce;
    if (burstNonce > 0) startWave();
  }, [burstNonce]);

  useEffect(() => {
    if (!stacked) setPlatformsExpanded(false);
  }, [stacked]);

  const fireSubmit = () => {
    if (!canSubmit) return;
    startWave();
    onSubmit();
  };

  return (
    <form
      className="kd-search-command"
      data-stacked={stacked || undefined}
      aria-busy={wavePhase === "run" || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (aiMode) sendRequest();
        else fireSubmit();
      }}
    >
      <div
        className="kd-searchbar kd-grow"
        data-ai={aiMode || undefined}
        data-ai-running={aiMode && aiRunning || undefined}
        data-has-ai={offered || undefined}
        data-batch={batch && !aiMode || undefined}
        data-stacked={stacked || undefined}
        data-platforms-expanded={stacked && platformsExpanded ? "true" : undefined}
        data-searching={wavePhase ?? undefined}
        data-kd-turn={rowTurn ?? undefined}
        data-attached={aiMode && attachments.length > 0 || undefined}
        {...(offered ? { [AI_DROP_ATTR]: "" } : {})}
        // Most drags are pointer drags that find this row themselves (TrackTable, searchDrag); a
        // system drag of library rows or search results arrives here.
        onDragOver={offered ? (event) => {
          if (!isTrackDrag(event) && !activeSearchDrag()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          event.currentTarget.setAttribute("data-kd-pointer-ai-over", "");
        } : undefined}
        onDragLeave={offered ? (event) => event.currentTarget.removeAttribute("data-kd-pointer-ai-over") : undefined}
        onDrop={offered ? (event) => {
          event.currentTarget.removeAttribute("data-kd-pointer-ai-over");
          const ids = isTrackDrag(event) ? readTrackDragIds(event.dataTransfer) : [];
          const search = ids.length ? null : readSearchDrop(event.dataTransfer);
          if (!ids.length && !search) return;
          event.preventDefault();
          event.stopPropagation();
          if (search) {
            finishSearchDrop();
            useAiStore.getState().attach(fromSearchDrag(search));
            return;
          }
          finishTrackDrop();
          void useLibraryStore.getState().resolveSummaries(ids)
            .then(tracks => useAiStore.getState().attach(fromLocalTracks(tracks)))
            .catch(() => undefined);
        } : undefined}
        style={barStyle}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && rowTurn === "in") setRowTurn(null);
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, select, input, textarea")) return;
          inputRef.current?.focus();
        }}
      >
        <div className="kd-searchbar-tools">
          {(searchKinds.length > 1 || aiMode) && (
            <button
              type="button"
              className="kd-search-kind"
              data-kind={aiMode ? "ai" : searchKind}
              aria-label={aiMode ? (aiRunning ? "Agent Mode，工作中：打开 AI 任务与历史" : "Agent Mode：打开 AI 任务与历史") : `搜索类型：${SEARCH_KIND_LABEL[searchKind]}，点击切换为${SEARCH_KIND_LABEL[nextSearchKind]}`}
              title={aiMode ? "AI 任务与历史" : `${SEARCH_KIND_LABEL[searchKind]}搜索 · 点击切换为${SEARCH_KIND_LABEL[nextSearchKind]}`}
              onClick={() => {
                // In Agent Mode the name opens the AI's drawer app: the task under way and the history.
                if (aiMode) useAiDrawer.getState().show("tasks");
                else onSearchKindChange(nextSearchKind);
              }}
            >
              {/* The row turns over into Agent Mode as a whole, so the kind does not roll on its own
                  then (keyed by the mode); while the agent works the field's edge runs. */}
              {aiMode && <Sparkles size={12} className="kd-search-agent-mark" aria-hidden="true" />}
              <RollText key={aiMode ? "ai" : "search"} text={aiMode ? "Agent Mode" : SEARCH_KIND_LABEL[searchKind]} className="kd-search-kind-text" />
            </button>
          )}
          <SearchPlatforms
            {...platformProps}
            collapsed={stacked && !platformsExpanded}
            onExpand={expandPlatforms}
            searchPhase={wavePhase}
            searchOutcome={searchOutcome}
          />
        </div>
        <div
          className="kd-searchbar-copy"
          data-empty={!shown || undefined}
          data-input-focused={inputFocused ? "true" : undefined}
          onPointerDown={() => {
            if (stacked && platformsExpanded) setPlatformsExpanded(false);
          }}
        >
          {/* The waveform of a search: the field's first layer, under the text. Keyed by the launch,
              not the phase, so an answer that comes back early lets it rise before it settles. */}
          {wavePhase ? (
            <span
              key={launch.seq}
              className="kd-search-wave"
              aria-hidden="true"
              style={{
                "--kd-search-text": `${launch.textEm}em`,
                "--kd-search-hold": wavePhase === "done" ? `${landingHold}ms` : undefined,
              } as CSSProperties}
            >
              <span className="kd-search-wave-line" />
              <span className="kd-search-wave-bars">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </span>
          ) : null}
          {!query && !aiMode && (
            <SearchTipCarousel
              inputFocused={inputFocused}
              tipsOpen={tipsOpen}
              onTips={onTips}
            />
          )}
          <textarea
            ref={inputRef}
            className="kd-searchbar-input"
            rows={inputRows}
            style={{ "--kd-search-rows": inputRows } as CSSProperties}
            value={aiMode ? request : query}
            placeholder=""
            // Titles and links are not prose: no spelling marks under them.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label={aiMode ? "交给 AI 的事" : "关键词、单曲链接或歌单链接，支持多行，@ 选择歌曲名"}
            role="combobox"
            {...(aiMode ? {} : presets.aria)}
            title={aiMode ? "交给 AI（Enter；Shift + Enter 换行）" : "搜索（Enter；Shift + Enter 换行；@ 歌曲名）"}
            onFocus={() => setInputFocused(true)}
            onBlur={event => {
              setInputFocused(false);
              if (!aiMode) presets.onBlur(event.relatedTarget);
            }}
            // Only a query with an @ in it has suggestions to place; plain typing does not track the caret.
            onSelect={!aiMode && query.includes("@") ? presets.syncCaret : undefined}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent;
              const composing = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
              if (!aiMode && !composing && presets.onKeyDown(event)) return;
              // 普通 Enter 永远不换行：搜索中或空框时也不能把 "\n" 写进去，否则会被当成批量搜索。
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                if (aiMode) sendRequest();
                else fireSubmit();
              }
            }}
            onPaste={(event) => {
              // A picture pasted here goes to the AI: a card in Agent Mode (aiAttachments.ts).
              if (!offered) return;
              const images = Array.from(event.clipboardData?.items ?? [])
                .filter(item => item.kind === "file" && item.type.startsWith("image/"))
                .map(item => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (!images.length) return;
              event.preventDefault();
              for (const image of images) {
                const preview = URL.createObjectURL(image);
                aiApi.paste(image)
                  .then(({ path }) => useAiStore.getState().attach([fromPastedImage(path, preview)]))
                  .catch(error => {
                    URL.revokeObjectURL(preview);
                    showTask({ id: "ai-paste", kind: "notice", title: "图片没能粘贴", detail: error instanceof Error ? error.message : String(error), tone: "error", placement: "top" });
                  });
              }
            }}
            onChange={(event) => {
              if (aiMode) {
                setRequest(event.target.value);
                return;
              }
              onQueryChange(event.target.value);
              if (event.target.value.includes("@")) presets.syncCaret();
            }}
          />
        </div>
        {/* What was dragged into Agent Mode: a card each, sent with the request (aiAttachments.ts).
            First, the earlier session the next request goes on in (历史 → 继续); × lets it go. */}
        {aiMode && (attachments.length > 0 || resume) && (
          <div className="kd-ai-chips" role="list" aria-label="附带给 AI">
            {resume && (
              <span className="kd-ai-chip" role="listitem" data-kd-turn="in" data-resume="" title={`下一句话接着这个会话：${resume.title}`}>
                <span className="kd-ai-chip-cover" aria-hidden="true"><History size={12} /></span>
                <span className="kd-ai-chip-time">接着</span>
                <span className="kd-ai-chip-title">{resume.title}</span>
                <button type="button" className="kd-ai-chip-remove" aria-label="不接着这个会话"
                  onClick={() => void useAiStore.getState().dropResume()}>
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            )}
            {attachments.map(item => {
              const time = timeLabel(item);
              return (
                <span key={item.key} className="kd-ai-chip" role="listitem" data-kd-turn="in" title={item.path ?? item.url ?? item.title}>
                  {item.cover
                    ? <img className="kd-ai-chip-cover" src={item.cover} alt="" draggable={false} />
                    : <span className="kd-ai-chip-cover" aria-hidden="true">{item.video ? <Video size={12} /> : <Music size={12} />}</span>}
                  <span className="kd-ai-chip-title">{item.title}</span>
                  {time && <span className="kd-ai-chip-time">{time}</span>}
                  <button type="button" className="kd-ai-chip-remove" aria-label={`移除 ${item.title}`}
                    onClick={() => useAiStore.getState().detach(item.key)}>
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {/* The keys at the end of the row: in Agent Mode first how hard the model thinks (a click
            steps through 低 中 高 极高), then AI mode's key, which stops the AI while it works.
            Something dragged onto the row turns it to Agent Mode with that thing attached. */}
        {offered && <span className="kd-search-ai-keys">
          {aiMode && <button
            type="button"
            className="kd-search-thinking"
            title={`推理强度：${THINKING_LABEL[thinking]} · 点击切换`}
            aria-label={`推理强度${THINKING_LABEL[thinking]}，点击切换为${THINKING_LABEL[nextThinking(thinking)]}`}
            onClick={() => void cycleThinking()}
          >{THINKING_LABEL[thinking]}</button>}
          <button
            type="button"
            className="kd-search-ai"
            {...{ [AI_DROP_ATTR]: "" }}
            aria-pressed={aiMode}
            data-running={aiRunning || undefined}
            aria-label={aiRunning ? "停止 AI" : aiMode ? "回到搜索" : "AI 模式"}
            title={aiRunning ? "停止 AI" : aiMode ? "回到搜索" : "AI 模式"}
            onClick={() => {
              if (aiRunning) void useAiStore.getState().abort();
              else useAiStore.getState().toggleMode();
            }}
          >
            {aiRunning ? <LoaderCircle size={16} className="kd-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
          </button>
        </span>}
      </div>
      {!aiMode && presets.menu}
    </form>
  );
}

/**
 * 搜索平台。多选 + 指针拖动排序。
 *
 * 不用 HTML5 draggable：WKWebView 上经常只 dragstart 不 drop，还会抢走 pointer 序列。
 */
export const SearchPlatforms = memo(function SearchPlatforms({
  platforms,
  onTogglePlatform,
  collapsed = false,
  onExpand,
  searchPhase = null,
  searchOutcome = null,
}: SearchPlatformProps) {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const settings = useAppStore((state) => state.settings);
  const settingsPriority = settings?.platform_priority ?? (DEFAULT_PRIORITY as string[]);
  const priority = settingsPriority;
  const [dragging, setDragging] = useState<Platform | null>(null);
  const [over, setOver] = useState<Platform | null>(null);
  const dragRef = useRef<{
    from: Platform;
    originX: number;
    originY: number;
    moved: boolean;
    over: Platform | null;
    pointerId: number;
    el: HTMLElement;
  } | null>(null);

  const orderedIds = normalizePriority(priority);
  // 设置里关掉的源直接不出现。
  const ordered = orderedIds
    .map((id) => SEARCH_PLATFORMS.find((item) => item.id === id))
    .filter((item): item is (typeof SEARCH_PLATFORMS)[number] => Boolean(item))
    .filter((item) => isPlatformEnabled(settings, item.id));
  // 收起态只摘要真正参与本次搜索的来源；把所有未选中的灰图标叠在一起既占位，
  // 也无法辨认。没有勾选来源时保留首项作为展开入口。
  const selectedOrdered = ordered.filter((item) => platforms.includes(item.id));
  const collapsedOrdered = (selectedOrdered.length ? selectedOrdered : ordered.slice(0, 1)).slice(0, 2);
  const collapsedOverflow = Math.max(0, selectedOrdered.length - collapsedOrdered.length);
  const rendered = collapsed ? collapsedOrdered : ordered;
  // The marks a search asks, in the order they answer.
  const asked = searchPhase ? rendered.filter((item) => platforms.includes(item.id)) : [];

  const reorder = (from: Platform, to: Platform) => {
    if (from === to) return;
    const current = orderedIds.slice();
    const fromAt = current.indexOf(from);
    const toAt = current.indexOf(to);
    if (fromAt < 0 || toAt < 0) return;
    current.splice(fromAt, 1);
    // 再取一次 to 的下标：from 抽走后后面的项会前移。
    const insertAt = current.indexOf(to);
    if (insertAt < 0) return;
    current.splice(insertAt, 0, from);
    void saveSettings({ platform_priority: current }).catch(() => undefined);
  };

  const platAtPoint = (x: number, y: number): Platform | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const btn = hit?.closest?.(".kd-plat") as HTMLElement | null;
    const id = btn?.getAttribute("data-platform");
    return id && orderedIds.includes(id as Platform) ? (id as Platform) : null;
  };

  const endDrag = () => {
    const session = dragRef.current;
    dragRef.current = null;
    if (!session) return;
    try {
      session.el.releasePointerCapture(session.pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);

    if (session.moved) {
      const target = session.over;
      if (target) reorder(session.from, target);
    } else {
      // 只渲染已启用的源，点击只切换这次搜索的勾选。
      onTogglePlatform(session.from);
    }
    setDragging(null);
    setOver(null);
  };

  const onPointerMove = (ev: PointerEvent) => {
    const session = dragRef.current;
    if (!session || ev.pointerId !== session.pointerId) return;
    if (!session.moved) {
      if (Math.hypot(ev.clientX - session.originX, ev.clientY - session.originY) < 4) return;
      session.moved = true;
      setDragging(session.from);
      try {
        session.el.setPointerCapture(session.pointerId);
      } catch {
        /* ignore */
      }
    }
    ev.preventDefault();
    const target = platAtPoint(ev.clientX, ev.clientY);
    const next = target && target !== session.from ? target : null;
    session.over = next;
    setOver(next);
  };

  const onPointerUp = (ev: PointerEvent) => {
    const session = dragRef.current;
    if (!session || ev.pointerId !== session.pointerId) return;
    // 松手前再瞄一次落点；指在缝隙上也用最后悬停过的目标。
    if (session.moved) {
      const target = platAtPoint(ev.clientX, ev.clientY);
      if (target && target !== session.from) session.over = target;
    }
    endDrag();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: Platform) => {
    if (event.button !== 0) return;
    if (collapsed) {
      event.preventDefault();
      event.stopPropagation();
      onExpand?.();
      return;
    }
    // 挡住浏览器默认拖图 / 选中，否则 pointer 序列会被掐断。
    event.preventDefault();
    event.stopPropagation();
    if (dragRef.current) endDrag();
    dragRef.current = {
      from: id,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
      over: null,
      pointerId: event.pointerId,
      el: event.currentTarget,
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  return (
    <div
      className="kd-plats"
      data-collapsed={collapsed ? "true" : undefined}
      role="group"
      aria-expanded={!collapsed}
      onPointerDown={(event) => {
        if (!collapsed || event.button !== 0 || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        onExpand?.();
      }}
      aria-label="搜索平台（拖动排序 = 来源优先级）"
    >
      {rendered.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className="kd-plat"
            aria-pressed={platforms.includes(item.id)}
            aria-label={collapsed ? `展开搜索平台，当前首项 ${item.label}` : item.label}
            tabIndex={collapsed && index > 0 ? -1 : 0}
            data-platform={item.id}
            data-dragging={dragging === item.id || undefined}
            data-drop={over === item.id || undefined}
            data-search={
              searchPhase && asked.includes(item)
                ? searchMarkState(searchPhase, item.id, searchOutcome)
                : undefined
            }
            style={{
              // Its place in the row: the marks come back out of Agent Mode one after another.
              "--kd-plat-n": index,
              ...(searchPhase && asked.includes(item) ? { "--kd-plat-i": asked.indexOf(item) } : {}),
            } as CSSProperties}
            draggable={false}
            title={
              item.video
                ? item.id === "bilibili"
                  ? `${item.label}（贴链接或 AV/BV 号自动走视频解析）· 拖动排序`
                  : `${item.label}（视频 / Shorts / 播放列表）· 拖动排序`
                : `${item.label} · 拖动排序：排前面的优先作为下载来源`
            }
            onPointerDown={(event) => onPointerDown(event, item.id)}
            onDragStart={(event) => event.preventDefault()}
            onClick={(event) => {
              // 真正的点击在 pointerup 里处理；这里挡住 form 提交式 click。
              event.preventDefault();
              if (collapsed) onExpand?.();
              else if (event.detail === 0) onTogglePlatform(item.id);
            }}
          >
            <PlatformMark id={item.id} />
          </button>
        ))}
      {collapsed && collapsedOverflow > 0 ? (
        <span className="kd-plat-more" aria-hidden="true">+{collapsedOverflow}</span>
      ) : null}
    </div>
  );
});
