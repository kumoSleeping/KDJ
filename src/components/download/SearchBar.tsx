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

export function SearchBar({
  query,
  searchKind,
  searchKinds,
  onSearchKindChange,
  onQueryChange,
  batch,
  busy,
  onSubmit,
  stacked = false,
  burstNonce = 0,
  burstTone = "rainbow",
  ...platformProps
}: SearchBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Some third-party dictation IMEs report Enter before React's isComposing
  // flag settles. Keep our own composition state and also honor keyCode 229.
  const composingRef = useRef(false);
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
          <SearchPlatforms {...platformProps} />
        </div>
        <span className="kd-searchbar-sep" aria-hidden="true" />
        <div className="kd-searchbar-copy" data-empty={!query || undefined}>
          {!query && (
            <span className="kd-search-placeholder" aria-hidden="true">
              开发者最近看了「全金属狂潮」「水果篮子(老版)」！
            </span>
          )}
          <textarea
            ref={inputRef}
            className="kd-searchbar-input"
            rows={1}
            value={query}
            placeholder=""
            aria-label="关键词、单曲链接或歌单链接，支持多行"
            title="搜索（Enter；Shift + Enter 换行）"
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
    void saveSettings({ platform_priority: current });
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
          void saveSettings(patchEnabledPlatform(snap, id, true));
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
      role="group"
      aria-label={
        independent
          ? "Explore 平台（拖动排序 = 来源优先级，与顶栏搜索独立）"
          : "搜索平台（拖动排序 = 来源优先级）"
      }
    >
      {ordered.map((item) => (
          <button
            key={item.id}
            type="button"
            className="kd-plat"
            aria-pressed={platforms.includes(item.id)}
            aria-label={item.label}
            data-platform={item.id}
            data-dragging={dragging === item.id || undefined}
            data-drop={over === item.id || undefined}
            draggable={false}
            title={
              item.video
                ? item.id === "bilibili"
                  ? `${item.label}（贴链接或 BV 号自动走视频解析）· 拖动排序`
                  : `${item.label}（视频 / Shorts / 播放列表）· 拖动排序`
                : `${item.label} · 拖动排序：排前面的优先作为下载来源`
            }
            onPointerDown={(event) => onPointerDown(event, item.id)}
            onDragStart={(event) => event.preventDefault()}
            onClick={(event) => {
              // 真正的点击在 pointerup 里处理；这里挡住 form 提交式 click。
              event.preventDefault();
            }}
          >
            <PlatformMark id={item.id} />
          </button>
        ))}
    </div>
  );
}
