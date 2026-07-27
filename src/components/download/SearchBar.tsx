import { useRef, useState } from "react";
import { Globe2, Link2, LoaderCircle, Rows3, Search } from "lucide-react";
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

export interface SearchBarProps extends SearchPlatformProps {
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

/**
 * 搜索条：**一个**控件，不是一排控件。
 *
 * 上一版这里是六七个描边矩形并排——输入框一个框、框里的音质又一个框、
 * 框外四颗平台键各自还有一个框。每多画一条边就多一次"这是另一件东西"的
 * 暗示，可它们回答的全是同一个问题的三个部分：搜什么、搜哪儿、要什么音质。
 * 现在连最外圈也不画，整条搜索直接嵌进顶部；内部分区只靠 1px 竖分隔线和留白，
 * 谁也不再单独描边；
 * 平台键的选中态改用「品牌色 + 一点同色底」表达，不靠边框。
 *
 * 网络入口用红色 Globe2 做语义提示，最右提交键仍是这条里的主动作；两者都不画边框。
 */
export function SearchBar({
  query,
  onQueryChange,
  batch,
  busy,
  onSubmit,
  quality,
  onQualityChange,
  defaultQuality,
  ...platformProps
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
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
        {/* 前导图标顺带当模式指示：网络搜索用 Globe2，链接用 Link2，贴成多行就变成"多条"那个图标。
            批量模式下它贴顶——文本域有四行高，图标浮在正中间会跟第二行文字打架。 */}
        <span className="kd-searchbar-lead" data-network="true" aria-hidden="true">
          {batch ? <Rows3 size={14} /> : isUrl ? <Link2 size={14} /> : <Globe2 size={14} />}
        </span>

        {batch ? (
          <textarea
            ref={(node) => {
              inputRef.current = node;
            }}
            className="kd-searchbar-input"
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
            ref={(node) => {
              inputRef.current = node;
            }}
            className="kd-searchbar-input"
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

        {/* 右半边一组：音质 / 平台 / 提交。分隔线只在"换了个话题"的地方画：
            输入 │ 这次要什么音质 │ 这次搜哪儿 → 提交。平台键之间不画线，
            它们是同一类东西，靠间距就分得开。 */}
        <div className="kd-searchbar-tools">
          <span className="kd-searchbar-sep" aria-hidden="true" />
          <select
            className="kd-searchbar-quality"
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

          <span className="kd-searchbar-sep" aria-hidden="true" />

          {/* 四家平台就长在搜索条里，不另起一行：它们回答的是"这次搜哪儿"，
              和输入框是同一个动作的两半；单开一行会让整个头部多占 40px，
              竖屏下那是好几条曲目的高度。 */}
          <SearchPlatforms {...platformProps} />

          {/* 整条搜索区唯一的红：提交。批量时它带上条数——贴了一大坨进去，
              得让人知道系统数出了几条，不然按下去是在赌。 */}
          <button
            type="submit"
            className="kd-searchbar-go"
            data-wide={batch || undefined}
            disabled={!canSubmit}
            aria-label={batch ? "批量处理" : isUrl ? "解析" : "搜索"}
            title={
              batch ? "批量处理（Cmd/Ctrl+Enter 也可以提交）" : isUrl ? "解析这条链接" : "搜索"
            }
          >
            {busy ? <LoaderCircle className="kd-spin" size={14} /> : <Search size={14} />}
            {batch && <span>批量处理{entryCount > 1 ? `（${entryCount}）` : ""}</span>}
          </button>
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
  );
}
