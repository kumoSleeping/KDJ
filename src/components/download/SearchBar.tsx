import { useRef, useState } from "react";
import type { Platform } from "../../types";
import { clearTextSelection } from "../../lib/textSelection";
import { useAppStore } from "../../stores/appStore";
import { PlatformMark } from "./PlatformMark";

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
}

function RainbowSearchIcon() {
  return (
    <svg className="kd-search-rainbow" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient
          id="kd-search-rainbow-stroke"
          gradientUnits="userSpaceOnUse"
          spreadMethod="repeat"
          x1="-8"
          y1="0"
          x2="0"
          y2="8"
        >
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="0.33" stopColor="#8b5cf6" />
          <stop offset="0.66" stopColor="#fb7299" />
          <stop offset="1" stopColor="#38bdf8" />
          <animate attributeName="x1" values="-8;0" dur="4.5s" repeatCount="indefinite" />
          <animate attributeName="x2" values="0;8" dur="4.5s" repeatCount="indefinite" />
          <animate attributeName="y1" values="0;8" dur="4.5s" repeatCount="indefinite" />
          <animate attributeName="y2" values="8;16" dur="4.5s" repeatCount="indefinite" />
        </linearGradient>
      </defs>
      <circle cx="11" cy="11" r="7.4" fill="none" stroke="url(#kd-search-rainbow-stroke)" strokeWidth="2.5" />
      <path d="m16.4 16.4 4.3 4.3" fill="none" stroke="url(#kd-search-rainbow-stroke)" strokeWidth="2.5" strokeLinecap="square" />
    </svg>
  );
}

/**
 * 搜索条：**一个**控件，不是一排控件。
 *
 * 搜索来源在最前，随后才是搜索输入；这样四个平台键和下方工作条的四个入口
 * 可以一一对齐。平台键只负责来源多选与顺序，登录仍有独立入口。
 */
export function SearchBar({
  query,
  onQueryChange,
  batch,
  busy,
  onSubmit,
  stacked = false,
  ...platformProps
}: SearchBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Some third-party dictation IMEs report Enter before React's isComposing
  // flag settles. Keep our own composition state and also honor keyCode 229.
  const composingRef = useRef(false);
  const canSubmit = query.trim().length > 0 && !busy;
  return (
    <form
      className="kd-search-command"
      data-stacked={stacked || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div
        className="kd-searchbar kd-grow"
        data-batch={batch || undefined}
        data-stacked={stacked || undefined}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, select, input, textarea")) return;
          inputRef.current?.focus();
        }}
      >
        <div className="kd-searchbar-tools">
          <SearchPlatforms {...platformProps} />
        </div>
        <div className="kd-searchbar-copy">
          <button
            type="submit"
            className="kd-searchbar-go"
            disabled={!canSubmit}
            aria-label={busy ? "正在搜索" : batch ? "开始批量解析" : "搜索"}
            title="搜索（Enter；Shift + Enter 换行）"
          >
            <RainbowSearchIcon />
          </button>
          {!query && (
            <span className="kd-search-placeholder" aria-hidden="true">
              {stacked ? "歌名、链接都可以放这里" : "今天想听点什么？歌名、链接，都可以悄悄放在这里 ♫"}
            </span>
          )}
          <textarea
            ref={inputRef}
            className="kd-searchbar-input"
            rows={1}
            value={query}
            placeholder=""
            aria-label="关键词、单曲链接或歌单链接，支持多行"
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
                onSubmit();
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
