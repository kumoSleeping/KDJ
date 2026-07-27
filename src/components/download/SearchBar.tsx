import { useRef, useState } from "react";
import type { Platform } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { PlatformMark } from "./PlatformMark";

/** 平台一览。哔哩哔哩挂着视频小标志：贴 B 站链接会自动走视频解析。 */
export const SEARCH_PLATFORMS: ReadonlyArray<{ id: Platform; label: string; video?: boolean }> = [
  { id: "wyy", label: "网易云" },
  { id: "qqm", label: "QQ 音乐" },
  { id: "soundcloud", label: "SOUNDCLOUD" },
  { id: "bilibili", label: "哔哩哔哩", video: true },
  { id: "local", label: "本地曲库" },
];

export const DEFAULT_PRIORITY: readonly string[] = ["local", "wyy", "qqm", "soundcloud", "bilibili"];

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
 * 上一版这里是六七个描边矩形并排——输入框一个框、框里的音质又一个框、
 * 框外四颗平台键各自还有一个框。每多画一条边就多一次"这是另一件东西"的
 * 暗示，可它们回答的全是同一个问题的三个部分：搜什么、搜哪儿、要什么音质。
 * 现在整个入口不画外轮廓：模式图标、动态动作标签和更大的主输入建立层级；
 * 音质与平台只用细分隔线和留白分区，谁也不再单独描边；
 * 平台键的选中态只点亮品牌色，不靠边框或淡色方块。
 *
 * Enter 执行搜索、Shift+Enter 换行；左侧炫彩放大镜同时是提交键，
 * 让第一次使用的人也不用猜快捷键，但不再铺红色按钮或描框。
 */
export function SearchBar({
  query,
  onQueryChange,
  batch,
  busy,
  onSubmit,
  ...platformProps
}: SearchBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = query.trim().length > 0 && !busy;
  return (
    <form
      className="kd-search-command"
      data-tauri-drag-region
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div
        className="kd-searchbar kd-grow"
        data-batch={batch || undefined}
        onClick={(event) => {
          // 整片顶部搜索区都是输入入口；但真实控件仍处理自己的点击，不能点音质
          // 下拉时把焦点强行抢回输入框，也不能破坏平台选择和提交。
          if ((event.target as HTMLElement).closest("button, select, input, textarea")) return;
          inputRef.current?.focus();
        }}
      >
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
              今天想听点什么？歌名、链接，都可以悄悄放在这里 ♫
            </span>
          )}
          <textarea
            ref={inputRef}
            className="kd-searchbar-input"
            rows={1}
            value={query}
            placeholder=""
            aria-label="关键词、单曲链接或歌单链接，支持多行"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && canSubmit) {
                event.preventDefault();
                onSubmit();
              }
            }}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <div className="kd-searchbar-tools">
          <SearchPlatforms {...platformProps} />
        </div>
      </div>
    </form>
  );
}

/**
 * 搜索平台。四颗只有标志的键，长在搜索条右半边。
 *
 * 只放各家的标志，不写名字：四个中文/英文名横着排要占掉半条工具栏，
 * 而这四家的品牌色和形状本来就是用户脑子里的第一识别项。名字进 title，
 * 需要确认的时候悬停一下就有。
 *
 * 每颗**不再各自描边**。四个方框并排看上去像四个独立控件，可它们其实是
 * 一组多选；现在选中 = 上品牌色 + 一层同色淡底，没选中 = 中性灰，
 * 状态一样读得出来，少了四条边。
 *
 * 按钮顺序 = 下载来源优先级：同一首歌几个平台都有时，默认从排最前的那家下。
 * 顺序可以直接拖动调整，存在设置里（platform_priority）。
 *
 * 「混合去重」的开关删掉了、恒为开：跨平台同一首歌不合并的话，
 * 搜一次出四条一模一样的结果，没有人会想要那个。
 */
export function SearchPlatforms({
  platforms,
  onTogglePlatform,
  soundcloudEnabled,
}: SearchPlatformProps) {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const openAccountsPanel = useAppStore((state) => state.openAccountsPanel);
  const priority = useAppStore(
    (state) => state.settings?.platform_priority ?? (DEFAULT_PRIORITY as string[]),
  );
  const [dragging, setDragging] = useState<Platform | null>(null);

  const rank = (id: Platform) => {
    const index = priority.indexOf(id);
    // 老设置里没有 local：第一次出现时默认贴着输入框；用户拖过一次后设置
    // 会正式包含 local，此后完全尊重保存的位置。
    if (id === "local" && index < 0) return -1;
    return index < 0 ? priority.length : index;
  };
  const ordered = [...SEARCH_PLATFORMS].sort((a, b) => rank(a.id) - rank(b.id));

  /** 把 from 拖到 to 的位置上（其余项相对顺序不变）。 */
  const reorder = (from: Platform, to: Platform) => {
    if (from === to) return;
    const current = ordered.map((item) => item.id);
    const next = current.filter((id) => id !== from);
    next.splice(next.indexOf(to) + (current.indexOf(from) < current.indexOf(to) ? 1 : 0), 0, from);
    void saveSettings({ platform_priority: next });
  };

  return (
    <div className="kd-plats" role="group" aria-label="搜索平台（拖动排序 = 来源优先级）">
      {ordered.map((item) => {
        // SoundCloud 默认关着（走 yt-dlp，慢且不稳）。但按钮直接置灰是个死胡同：
        // 用户点不动，也没人告诉他为什么。改成点一下就把开关打开——
        // 他的意图很明确，没道理逼他跑去设置里再找一遍。
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
            // 名字进 title：按钮上只有标志，悬停才说是谁
            title={
              off
                ? `${item.label}：未启用，点一下就启用`
                : item.video
                  ? `${item.label}（贴链接或 BV 号自动走视频解析）· 拖动排序`
                  : `${item.label} · 拖动排序：排前面的优先作为下载来源`
            }
            onDragStart={(event) => {
              if (item.id !== "local") openAccountsPanel();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.id);
              setDragging(item.id);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              if (dragging && dragging !== item.id) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (item.id !== "local") openAccountsPanel();
              if (dragging) reorder(dragging, item.id);
              setDragging(null);
            }}
            onClick={() => {
              if (item.id !== "local") openAccountsPanel();
              if (off) {
                // 启用之后这颗按钮的"未启用"灰态当场就没了，还顺手被选中，
                // 这本身就是回执，不必再说一遍"已启用 SoundCloud"
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
