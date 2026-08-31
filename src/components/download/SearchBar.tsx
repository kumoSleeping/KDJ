import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Platform, SearchKind } from "../../types";
import { isPlatformEnabled, patchEnabledPlatform } from "../../lib/enabledPlatforms";
import {
  DEFAULT_PRIORITY,
  DEFAULT_SEARCH_PLATFORMS,
  normalizePriority,
  normalizeSearchPlatforms,
  SEARCH_PLATFORMS,
} from "../../lib/searchPlatforms";
import { useAppStore } from "../../stores/appStore";
import { PlatformMark } from "./PlatformMark";
import { HintBulbIcon } from "./HintBulbIcon";
import { burstToneForPlatforms, SearchBurstFX, type SearchBurstTone } from "./SearchBurstFX";

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
  /**
   * 不传则读写 settings.platform_priority（顶栏搜索）。
   * Explore 传入自己的 priority / onReorder，与顶栏互不同步。
   */
  priority?: readonly string[];
  onReorder?: (next: Platform[]) => void;
  /** 手机顶栏的重叠预览；第一次点只展开，不误切来源。 */
  collapsed?: boolean;
  onExpand?: () => void;
}

export interface SearchBarProps extends SearchPlatformProps {
  query: string;
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
  /**
   * 外部触发扫光（如 Explore 代填提交）。数值变化即重放；
   * burstTone：单平台品牌色 / 多平台彩虹（与手动提交同一规则）。
   */
  burstNonce?: number;
  burstTone?: SearchBurstTone;
}

/**
 * 在线搜索：顶栏正中的圆角小框。
 *
 * 搜索来源在最前，细分割线后是输入；平台键只负责来源多选与顺序。
 * 提交靠 Enter（Shift+Enter 换行），不再单独放放大镜。
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
  "分析面板右上角的两个按钮可用于定位和固定面板。",
  "搜索/在线歌单可以直接拖动到任意本地板块!",
  "您可以直接在 KDJ 中，从自己的歌单或收藏中移除歌曲！",
  "请不要在社交平台公开传播本软件，谢谢理解！",
  "右键歌曲复制来源链接, 和小程序卡片一样!",
  "如果歌曲没有封面, 详情板块有很多方法补充~",
  "开发者认为「水果篮子」老版比新版好看太多了。",
  "音量条左侧按钮包含智能过渡、歌词和视频小窗功能！",
  "可通过系统媒体控制快捷键、Android 控制中心或灵动岛操控播放哟~",
  "不喜欢视频小窗？播放视频时，点击与歌词共用的按钮关闭小窗!",
  "视频支持系统级小窗! 详情界面也有视频播放哟~",
  "拖动详情面板左上角的把手，可以自由调整板块顺序。",
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

  const tip = inputFocused ? SEARCH_INPUT_TIP : SEARCH_TIPS[tipIndex];

  return (
    <span className="kd-search-placeholder">
      <span
        key={tipIndex}
        className="kd-search-tip"
        data-fixed={inputFocused || actionFocused ? "true" : undefined}
        data-input-focused={inputFocused ? "true" : undefined}
      >
        {!inputFocused ? (
          <button
            type="button"
            className="kd-search-tip-action"
            data-open={tipsOpen ? "true" : undefined}
            aria-label={tipsOpen ? "收起使用提示" : "查看全部使用提示"}
            aria-pressed={tipsOpen}
            title={tipsOpen ? "收起使用提示" : "查看全部使用提示"}
            onFocus={() => setActionFocused(true)}
            onBlur={() => setActionFocused(false)}
            onClick={onTips}
          >
            <HintBulbIcon size={14} aria-hidden="true" />
          </button>
        ) : null}
        <span className="kd-search-tip-copy" aria-hidden="true">{tip}</span>
      </span>
    </span>
  );
}

export function SearchBar({
  query,
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
  burstTone = "rainbow",
  ...platformProps
}: SearchBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Some third-party dictation IMEs report Enter before React's isComposing
  // flag settles. Keep our own composition state and also honor keyCode 229.
  const composingRef = useRef(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [platformsExpanded, setPlatformsExpanded] = useState(false);
  const [burst, setBurst] = useState<SearchBurstTone | null>(null);
  /** 扫光还在等结果：见过 busy=true 之后，busy 落回 false 才淡出关闭。 */
  const burstPendingRef = useRef(false);
  const burstSawBusyRef = useRef(false);
  const [burstActive, setBurstActive] = useState(false);
  const lastNonceRef = useRef(burstNonce);
  const canSubmit = query.trim().length > 0 && !busy;
  const currentKindIndex = searchKinds.indexOf(searchKind);
  const nextSearchKind = searchKinds.length
    ? searchKinds[(Math.max(-1, currentKindIndex) + 1) % searchKinds.length]
    : searchKind;

  const playBurst = (tone: SearchBurstTone) => {
    burstPendingRef.current = true;
    // Explore 代搜时 submit 可能已经把 busy 拉高，这一帧就要算「见过 busy」。
    burstSawBusyRef.current = busy;
    setBurstActive(true);
    // 先卸再挂，保证同色重搜也会重开动效。
    setBurst(null);
    requestAnimationFrame(() => setBurst(tone));
  };

  useEffect(() => {
    if (!burstPendingRef.current) return;
    if (busy) {
      burstSawBusyRef.current = true;
      return;
    }
    // 提交瞬间 busy 还没拉高：先别关。等真正跑完一轮再淡出。
    if (!burstSawBusyRef.current) return;
    burstPendingRef.current = false;
    setBurstActive(false);
  }, [busy]);

  useEffect(() => {
    if (burstNonce === lastNonceRef.current) return;
    lastNonceRef.current = burstNonce;
    if (burstNonce > 0) playBurst(burstTone);
  }, [burstNonce, burstTone]);

  useEffect(() => {
    if (!stacked) setPlatformsExpanded(false);
  }, [stacked]);

  const fireSubmit = () => {
    if (!canSubmit) return;
    // 与 Explore 同一规则：只开一家用品牌色，多家用彩色。
    playBurst(burstToneForPlatforms(platformProps.platforms));
    onSubmit();
  };

  return (
    <form
      className="kd-search-command"
      data-stacked={stacked || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        fireSubmit();
      }}
    >
      <div
        className="kd-searchbar kd-grow"
        data-batch={batch || undefined}
        data-stacked={stacked || undefined}
        data-platforms-expanded={stacked && platformsExpanded ? "true" : undefined}
        data-burst={burst || undefined}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, select, input, textarea")) return;
          inputRef.current?.focus();
        }}
      >
        {burst ? (
          <SearchBurstFX
            tone={burst}
            active={burstActive}
            onFinished={() => setBurst(null)}
          />
        ) : null}
        <div className="kd-searchbar-tools">
          {searchKinds.length > 1 && (
            <button
              type="button"
              className="kd-search-kind"
              data-kind={searchKind}
              aria-label={`搜索类型：${SEARCH_KIND_LABEL[searchKind]}，点击切换为${SEARCH_KIND_LABEL[nextSearchKind]}`}
              title={`${SEARCH_KIND_LABEL[searchKind]}搜索 · 点击切换为${SEARCH_KIND_LABEL[nextSearchKind]}`}
              onClick={() => onSearchKindChange(nextSearchKind)}
            >
              {SEARCH_KIND_LABEL[searchKind]}
            </button>
          )}
          <SearchPlatforms
            {...platformProps}
            collapsed={stacked && !platformsExpanded}
            onExpand={() => setPlatformsExpanded(true)}
          />
        </div>
        <span className="kd-searchbar-sep" aria-hidden="true" />
        <div
          className="kd-searchbar-copy"
          data-empty={!query || undefined}
          data-input-focused={inputFocused ? "true" : undefined}
          onPointerDown={() => {
            if (stacked && platformsExpanded) setPlatformsExpanded(false);
          }}
        >
          {!query && (
            <SearchTipCarousel
              inputFocused={inputFocused}
              tipsOpen={tipsOpen}
              onTips={onTips}
            />
          )}
          <textarea
            ref={inputRef}
            className="kd-searchbar-input"
            rows={1}
            value={query}
            placeholder=""
            aria-label="关键词、单曲链接或歌单链接，支持多行"
            title="搜索（Enter；Shift + Enter 换行）"
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent;
              const composing = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
              if (event.key === "Enter" && !event.shiftKey && !composing && canSubmit) {
                event.preventDefault();
                fireSubmit();
              }
            }}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>
    </form>
  );
}

/**
 * 搜索平台。多选 + 指针拖动排序。
 *
 * 不用 HTML5 draggable：WKWebView 上经常只 dragstart 不 drop，还会抢走 pointer 序列。
 */
export function SearchPlatforms({
  platforms,
  onTogglePlatform,
  priority: priorityProp,
  onReorder,
  collapsed = false,
  onExpand,
}: SearchPlatformProps) {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const settings = useAppStore((state) => state.settings);
  const settingsPriority = settings?.platform_priority ?? (DEFAULT_PRIORITY as string[]);
  const priority = priorityProp ?? settingsPriority;
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

  /** 传入 onReorder = Explore 独立条：勾选/排序自管，不跟顶栏同步。 */
  const independent = Boolean(onReorder);
  const orderedIds = normalizePriority(priority);
  // 顶栏：设置里关掉的源直接不出现；Explore 独立条仍列出全部，点选时可顺手启用。
  const ordered = orderedIds
    .map((id) => SEARCH_PLATFORMS.find((item) => item.id === id))
    .filter((item): item is (typeof SEARCH_PLATFORMS)[number] => Boolean(item))
    .filter((item) => independent || isPlatformEnabled(settings, item.id));
  // 收起态只摘要真正参与本次搜索的来源；把所有未选中的灰图标叠在一起既占位，
  // 也无法辨认。没有勾选来源时保留首项作为展开入口。
  const selectedOrdered = ordered.filter((item) => platforms.includes(item.id));
  const collapsedOrdered = (selectedOrdered.length ? selectedOrdered : ordered.slice(0, 1)).slice(0, 2);
  const collapsedOverflow = Math.max(0, selectedOrdered.length - collapsedOrdered.length);
  const rendered = collapsed ? collapsedOrdered : ordered;

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
    if (onReorder) {
      onReorder(current);
      return;
    }
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
      const id = session.from;
      const snap = useAppStore.getState().settings;
      if (independent) {
        // Explore：勾选独立；若全局未开该源则顺手启用，方便真正发出请求。
        if (!platforms.includes(id) && snap && !isPlatformEnabled(snap, id)) {
          void saveSettings(patchEnabledPlatform(snap, id, true)).catch(() => undefined);
        }
        onTogglePlatform(id);
      } else {
        // 顶栏只渲染已启用源，点击只切换搜索勾选。
        onTogglePlatform(id);
      }
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
      aria-label={
        independent
          ? "Explore 平台（拖动排序 = 来源优先级，与顶栏搜索独立）"
          : "搜索平台（拖动排序 = 来源优先级）"
      }
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
}
