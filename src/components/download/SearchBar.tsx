import { useState } from "react";
import { Link2, LoaderCircle, Rows3, Search } from "lucide-react";
import type { Platform, Quality } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { PlatformMark } from "./PlatformMark";

/** 平台一览。哔哩哔哩挂着视频小标志：贴 B 站链接会自动走视频解析。 */
export const SEARCH_PLATFORMS: ReadonlyArray<{ id: Platform; label: string; video?: boolean }> = [
  { id: "wyy", label: "网易云" },
  { id: "qqm", label: "QQ 音乐" },
  { id: "soundcloud", label: "SOUNDCLOUD" },
  { id: "bilibili", label: "哔哩哔哩", video: true },
];

export const DEFAULT_PRIORITY: readonly string[] = ["wyy", "qqm", "soundcloud", "bilibili"];

/** 平台选择那一行单独一个组件（SearchPlatforms），props 也分开列。 */
export interface SearchPlatformProps {
  platforms: Platform[];
  onTogglePlatform(platform: Platform): void;
  soundcloudEnabled: boolean;
}

export interface SearchBarProps {
  query: string;
  onQueryChange(value: string): void;
  /** 批量模式由输入内容推导（有换行/多条链接），不再有开关按钮。 */
  batch: boolean;
  busy: boolean;
  onSubmit(): void;
  quality: Quality | "";
  onQualityChange(value: Quality | ""): void;
  defaultQuality: string;
}

/** 只用来给单行输入换个图标，真正的链接判定在后端。 */
const LOOKS_LIKE_URL = /^\s*https?:\/\//i;

export function SearchBar({
  query,
  onQueryChange,
  batch,
  busy,
  onSubmit,
  quality,
  onQualityChange,
  defaultQuality,
}: SearchBarProps) {
  const isUrl = LOOKS_LIKE_URL.test(query);
  const canSubmit = query.trim().length > 0 && !busy;
  // 拆分规则和后端 split_intake_text 保持一致：有换行只按行拆，没换行才按逗号拆
  const entryCount = batch
    ? new Set(
        (query.includes("\n") ? query.split("\n") : query.split(/[,，、;；\t]+/))
          .map((line) => line.trim())
          .filter(Boolean),
      ).size
    : 0;

  return (
    <form
      className="kd-toolbar"
      style={batch ? { alignItems: "flex-start" } : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      {/* 批量模式才在外面留图标位：文本域有四行高，图标压在里面会跟文字打架 */}
      {batch && (
        <span className="kd-muted kd-row" style={{ gap: "0.35rem", height: "1.85rem" }}>
          <Rows3 size={14} />
        </span>
      )}

      {batch ? (
        <textarea
          className="kd-textarea kd-grow"
          rows={4}
          value={query}
          placeholder={
            "一行一条，或用逗号分隔。歌名和链接可以混着贴：\n" +
            "Snow halation\nFive More Hours - Deorro\nhttps://music.163.com/playlist?id=..."
          }
          aria-label="批量关键词或链接"
          autoFocus
          // Cmd/Ctrl+Enter 提交：文本域里回车是换行，不能拿来当提交键
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      ) : (
        // 搜索键住在输入框**里面**：它和输入框是同一件事的两半，
        // 摆成外面一颗独立的红按钮会让它跟顶上真正的动作抢注意力，
        // 而且横着吃掉一大截本该给输入框的宽度。
        <div className="kd-searchbox kd-grow">
          <span className="kd-searchbox-lead" aria-hidden="true">
            {isUrl ? <Link2 size={14} /> : <Search size={14} />}
          </span>
          <input
            value={query}
            placeholder="歌名 / 艺人，或直接粘贴歌单、单曲分享链接（多行内容自动批量）"
            aria-label="搜索关键词或链接"
            onChange={(event) => onQueryChange(event.target.value)}
            // 多行文本贴进单行输入框会被浏览器压成一行，批量意图就丢了；
            // 拦下来原样放进 query，换行一到位就自动切成批量文本域
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (!/[\r\n]/.test(text.trim())) return;
              event.preventDefault();
              const clean = text.replace(/\r\n?/g, "\n").trim();
              onQueryChange(query.trim() ? `${query.trim()}\n${clean}` : clean);
            }}
          />
          <select
            className="kd-searchbox-quality"
            value={quality}
            aria-label="下载音质"
            title="这次下载用什么音质"
            onChange={(event) => onQualityChange(event.target.value as Quality | "")}
          >
            <option value="">{defaultQuality.toUpperCase()}</option>
            <option value="flac">FLAC</option>
            <option value="320">320K</option>
            <option value="128">128K</option>
          </select>
          <button
            type="submit"
            className="kd-searchbox-go"
            disabled={!canSubmit}
            aria-label={isUrl ? "解析" : "搜索"}
            title={isUrl ? "解析这条链接" : "搜索"}
          >
            {busy ? <LoaderCircle className="kd-spin" size={14} /> : <Search size={14} />}
          </button>
        </div>
      )}

      {/* 批量模式：文本域是四行高，右边空得下一颗正经按钮，而且"批量处理 N 条"
          这个数字必须说出来——贴了一大坨进去，得让人知道系统数出了几条 */}
      {batch && (
        <button
          type="submit"
          className="kd-btn"
          data-variant="primary"
          disabled={!canSubmit}
          title="Cmd/Ctrl+Enter 也可以提交"
        >
          {busy ? <LoaderCircle className="kd-spin" size={13} /> : <Search size={13} />}
          批量处理{entryCount > 1 ? `（${entryCount}）` : ""}
        </button>
      )}
    </form>
  );
}

/**
 * 搜索平台。单独一条窄行，跟在大搜索框下面。
 *
 * 只放各家的标志，不写名字：四个中文/英文名横着排要占掉半条工具栏，
 * 而这四家的品牌色和形状本来就是用户脑子里的第一识别项。名字进 title，
 * 需要确认的时候悬停一下就有。
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
  const priority = useAppStore(
    (state) => state.settings?.platform_priority ?? (DEFAULT_PRIORITY as string[]),
  );
  const [dragging, setDragging] = useState<Platform | null>(null);

  const rank = (id: Platform) => {
    const index = priority.indexOf(id);
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
    <div className="kd-toolbar" data-slim="true">
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
                if (dragging) reorder(dragging, item.id);
                setDragging(null);
              }}
              onClick={() => {
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

    </div>
  );
}
