import { useState } from "react";
import { Clapperboard, Link2, LoaderCircle, Rows3, Search } from "lucide-react";
import type { Platform, Quality } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { Button } from "../common";

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
  merge: boolean;
  onMergeChange(value: boolean): void;
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
      <span className="kd-muted kd-row" style={{ gap: "0.35rem", height: "1.85rem" }}>
        {batch ? <Rows3 size={14} /> : isUrl ? <Link2 size={14} /> : <Search size={14} />}
      </span>

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
        <input
          className="kd-input kd-grow"
          data-size="lg"
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
      )}

      <div className="kd-row" style={{ gap: "0.3rem" }}>
        <select
          className="kd-select"
          data-size="sm"
          value={quality}
          aria-label="下载音质"
          title="这次下载用什么音质"
          onChange={(event) => onQualityChange(event.target.value as Quality | "")}
        >
          <option value="">默认（{defaultQuality}）</option>
          <option value="flac">FLAC</option>
          <option value="320">320K</option>
          <option value="128">128K</option>
        </select>
        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          title={batch ? "Cmd/Ctrl+Enter 也可以提交" : undefined}
        >
          {busy ? <LoaderCircle className="kd-spin" size={13} /> : <Search size={13} />}
          {batch ? `批量处理${entryCount > 1 ? `（${entryCount}）` : ""}` : isUrl ? "解析" : "搜索"}
        </Button>
      </div>
    </form>
  );
}

/**
 * 搜索平台与去重开关。单独一条窄行，跟在大搜索框下面。
 *
 * 按钮顺序 = 下载来源优先级：同一首歌几个平台都有时，默认从排最前的那家下。
 * 顺序可以直接拖动调整，存在设置里（platform_priority）。
 */
export function SearchPlatforms({
  platforms,
  onTogglePlatform,
  merge,
  onMergeChange,
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
      <div className="kd-segment" role="group" aria-label="搜索平台（拖动排序 = 来源优先级）">
        {ordered.map((item) => {
          // SoundCloud 默认关着（走 yt-dlp，慢且不稳）。但按钮直接置灰是个死胡同：
          // 用户点不动，也没人告诉他为什么。改成点一下就把开关打开——
          // 他的意图很明确，没道理逼他跑去设置里再找一遍。
          const off = item.id === "soundcloud" && !soundcloudEnabled;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={platforms.includes(item.id)}
              data-platform={item.id}
              data-off={off || undefined}
              data-dragging={dragging === item.id || undefined}
              draggable
              title={
                off
                  ? "SoundCloud 未启用（走 yt-dlp，速度不稳）。点一下就启用"
                  : item.video
                    ? "贴 B 站链接或 BV 号会自动走视频解析。拖动可调整来源优先级"
                    : "拖动排序：排前面的平台优先作为下载来源"
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
              {item.label}
              {item.video && <Clapperboard size={11} style={{ marginLeft: "0.3rem" }} />}
            </button>
          );
        })}
      </div>

      <label className="kd-check" title="跨平台同一首歌合并成一条，下载时可挑来源">
        <input
          type="checkbox"
          checked={merge}
          onChange={(event) => onMergeChange(event.target.checked)}
        />
        混合去重
      </label>
    </div>
  );
}
