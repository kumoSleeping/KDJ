import { useEffect, useRef, useState } from "react";
import type { Platform } from "../../types";
import { clearTextSelection } from "../../lib/textSelection";
import { useAppStore } from "../../stores/appStore";
import { PlatformMark } from "./PlatformMark";
import { SearchBurstFX, type SearchBurstTone } from "./SearchBurstFX";

/** 平台一览（仅在线源）。本地曲库在左侧树里浏览，不再占搜索来源位。 */
export const SEARCH_PLATFORMS: ReadonlyArray<{ id: Platform; label: string; video?: boolean }> = [
  { id: "wyy", label: "网易云" },
  { id: "qqm", label: "QQ 音乐" },
  { id: "soundcloud", label: "SOUNDCLOUD" },
  { id: "bilibili", label: "哔哩哔哩", video: true },
];

export const DEFAULT_PRIORITY: readonly string[] = ["wyy", "qqm", "soundcloud", "bilibili"];
/** 默认勾选：网易云 / QQ / B 站；SoundCloud 需先启用。 */
export const DEFAULT_SEARCH_PLATFORMS: readonly Platform[] = ["wyy", "qqm", "bilibili"];

/** 补齐缺失平台；丢掉已下线的 local 等旧项。 */
function normalizePriority(priority: readonly string[]): Platform[] {
  const known = SEARCH_PLATFORMS.map((item) => item.id);
  const ordered = priority.filter((id): id is Platform => known.includes(id as Platform));
  for (const id of known) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

/** 勾选列表：只保留仍在线的平台；空/缺省回落到默认勾选。 */
export function normalizeSearchPlatforms(selected: readonly string[] | undefined): Platform[] {
  const known = SEARCH_PLATFORMS.map((item) => item.id);
  const next = (selected ?? []).filter((id): id is Platform => known.includes(id as Platform));
  return next.length > 0 ? next : [...DEFAULT_SEARCH_PLATFORMS];
}

/** 平台选择那一行单独一个组件（SearchPlatforms），props 也分开列。 */
export interface SearchPlatformProps {
  platforms: Platform[];
  onTogglePlatform(platform: Platform): void;
  soundcloudEnabled: boolean;
}

export interface SearchBarProps extends SearchPlatformProps {
  query: string;
  onQueryChange(value: string): void;
  /** 批量模式由输入内容推导（有换行/多条链接），不再有开关按钮。 */
  batch: boolean;
  busy: boolean;
  onSubmit(): void;
  /** 竖屏/极窄：输入与平台拆成两段。 */
  stacked?: boolean;
  /**
   * 外部触发扫光（如「搜 VJ」代填提交）。数值变化即重放；
   * 搭配 burstTone 选彩虹或粉色。
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
export function SearchBar({
  query,
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
  const burstTimerRef = useRef<number | null>(null);
  const lastNonceRef = useRef(burstNonce);
  const canSubmit = query.trim().length > 0 && !busy;

  const playBurst = (tone: SearchBurstTone) => {
    if (burstTimerRef.current != null) window.clearTimeout(burstTimerRef.current);
    setBurst(null);
    const duration = tone === "pink" ? 1000 : 900;
    requestAnimationFrame(() => {
      setBurst(tone);
      burstTimerRef.current = window.setTimeout(() => {
        setBurst(null);
        burstTimerRef.current = null;
      }, duration);
    });
  };

  useEffect(() => {
    return () => {
      if (burstTimerRef.current != null) window.clearTimeout(burstTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (burstNonce === lastNonceRef.current) return;
    lastNonceRef.current = burstNonce;
    if (burstNonce > 0) playBurst(burstTone);
  }, [burstNonce, burstTone]);

  const fireSubmit = () => {
    if (!canSubmit) return;
    playBurst("rainbow");
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
        {burst ? <SearchBurstFX tone={burst} /> : null}
        <div className="kd-searchbar-tools">
          <SearchPlatforms {...platformProps} />
        </div>
        <span className="kd-searchbar-sep" aria-hidden="true" />
        <div className="kd-searchbar-copy" data-empty={!query || undefined}>
          {!query && (
            <span className="kd-search-placeholder" aria-hidden="true">
              喵喵喵?
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
 * 搜索平台。只负责来源多选与拖动排序——不再打开账号面板。
 */
export function SearchPlatforms({
  platforms,
  onTogglePlatform,
  soundcloudEnabled,
}: SearchPlatformProps) {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const priority = useAppStore(
    (state) => state.settings?.platform_priority ?? (DEFAULT_PRIORITY as string[]),
  );
  const [dragging, setDragging] = useState<Platform | null>(null);
  // dragover 比 setState 重渲染更早：必须用 ref，否则 preventDefault 来不及，整段拖不动。
  const draggingRef = useRef<Platform | null>(null);

  const orderedIds = normalizePriority(priority);
  const ordered = orderedIds
    .map((id) => SEARCH_PLATFORMS.find((item) => item.id === id))
    .filter((item): item is (typeof SEARCH_PLATFORMS)[number] => Boolean(item));

  const reorder = (from: Platform, to: Platform) => {
    if (from === to) return;
    const current = ordered.map((item) => item.id);
    const next = current.filter((id) => id !== from);
    const at = next.indexOf(to);
    if (at < 0) return;
    next.splice(at, 0, from);
    void saveSettings({ platform_priority: next });
  };

  return (
    <div className="kd-plats" role="group" aria-label="搜索平台（拖动排序 = 来源优先级）">
      {ordered.map((item) => {
        const off = item.id === "soundcloud" && !soundcloudEnabled;
        return (
          <button
            key={item.id}
            type="button"
            className="kd-plat"
            aria-pressed={platforms.includes(item.id)}
            aria-label={item.label}
            data-platform={item.id}
            data-off={off || undefined}
            data-dragging={dragging === item.id || undefined}
            draggable
            title={
              off
                ? `${item.label}：未启用，点一下就启用`
                : item.video
                  ? `${item.label}（贴链接或 BV 号自动走视频解析）· 拖动排序`
                  : `${item.label} · 拖动排序：排前面的优先作为下载来源`
            }
            onDragStart={(event) => {
              clearTextSelection();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.id);
              draggingRef.current = item.id;
              setDragging(item.id);
            }}
            onDragEnd={() => {
              draggingRef.current = null;
              setDragging(null);
            }}
            onDragOver={(event) => {
              if (draggingRef.current && draggingRef.current !== item.id) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const from = draggingRef.current;
              if (from) reorder(from, item.id);
              draggingRef.current = null;
              setDragging(null);
            }}
            onClick={() => {
              if (off) {
                void saveSettings({ soundcloud_enabled: true });
                if (!platforms.includes(item.id)) onTogglePlatform(item.id);
                return;
              }
              onTogglePlatform(item.id);
            }}
          >
            <PlatformMark id={item.id} />
          </button>
        );
      })}
    </div>
  );
}
