import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Music4 } from "lucide-react";
import { api } from "../../lib/api";
import { DASH, formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { MergedGroup, VideoFormat, VideoInfo } from "../../types";
import { Button, InlineNotice } from "../common";
import { requestVideoPreview } from "./VideoPreview";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 画质是"上限"而不是"精确档"：后端在可用流里挑不超过这个高度的最好的一条。 */
const HEIGHT_LADDER = [2160, 1440, 1080, 720, 480, 360];

/**
 * 画出一行视频要的最少信息。
 *
 * 关键词搜出来的 B 站条目只有这些（`SongSource` 那条路不带分 P 和可用画质），
 * 贴链接解析出来的 `VideoInfo` 是它的超集，所以两条路共用同一个种子结构。
 */
export interface VideoSeed {
  bvid: string;
  title: string;
  author: string;
  cover: string;
  duration: number | null;
}

/**
 * 整组来源都是 B 站才当视频看。
 *
 * 混进了音乐平台的那种本质上是一首歌，B 站只是它可选的下载来源之一；
 * 按视频铺开反而会把"同一首歌有几家可选、默认走哪家"这件事藏起来。
 */
export function isVideoGroup(group: MergedGroup): boolean {
  return (
    group.sources.length > 0 && group.sources.every((source) => source.platform === "bilibili")
  );
}

export function videoSeedFromGroup(group: MergedGroup): VideoSeed {
  const source = group.sources[0];
  return {
    // key 就是 bvid，payload 里那份是同一个值；两处都取一下免得哪天只填了一处
    bvid: String(source?.payload?.bvid ?? source?.key ?? ""),
    title: group.title,
    author: group.artists.join(", "),
    cover: group.cover,
    duration: group.duration,
  };
}

export function videoSeedFromInfo(info: VideoInfo): VideoSeed {
  return {
    bvid: info.bvid,
    title: info.title,
    author: info.author,
    cover: info.cover,
    duration: info.duration,
  };
}

/**
 * 解析结果按 bvid 缓存。
 * 切标签、滚回去、重搜同一个关键词都会把行重新挂载一遍，
 * 每次都打一趟 B 站纯属白费，还平白增加被风控的机会。
 */
const resolvedCache = new Map<string, VideoInfo>();

export interface VideoResultRowProps extends VideoSeed {
  /** 已经解析好的完整信息（贴链接那条路）。不给就等这行滚进视口自己去解析。 */
  info?: VideoInfo | null;
  /** 视频行横跨整张表，列数由表头决定。 */
  colSpan: number;
}

/**
 * 搜索结果里的一条视频。
 *
 * 视频和歌不是两个板块，只是同一张结果表里长得不一样的两种行：
 * 一首歌一行文字就说完了，视频得先看见画面才知道是不是要的那个，
 * 所以这行占两倍高度、左边放 16:9 的封面、右边把"要下哪一档"的旋钮全摆出来。
 * 原来那个独立的视频面板做的就是这件事，只是它自己霸占了一个标签页。
 */
export function VideoResultRow({
  bvid,
  title,
  author,
  cover,
  duration,
  info: given,
  colSpan,
}: VideoResultRowProps) {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const mergeTasks = useDownloadStore((state) => state.mergeTasks);

  const [info, setInfo] = useState<VideoInfo | null>(given ?? resolvedCache.get(bvid) ?? null);
  const [pageIndex, setPageIndex] = useState(0);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [sending, setSending] = useState(false);
  /** 下载失败的原因，贴在这一行自己的按钮旁边——参数还在，再按一次就是重试。 */
  const [sendError, setSendError] = useState("");
  const rowRef = useRef<HTMLTableRowElement>(null);

  const effectiveHeight = maxHeight ?? settings?.video_max_height ?? 1080;
  const pages = info?.pages ?? [];

  /**
   * 关键词搜出来的视频没有分 P 和可用画质，得再问一次 B 站才知道。
   * 一屏几十条一起打过去正是最容易触发风控的形状（见 HANDOFF 的坑表），
   * 所以等这一行真的滚进视口了再解析——不看的那些根本不发请求。
   */
  useEffect(() => {
    if (info) return;
    const node = rowRef.current;
    if (!node) return;
    let alive = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void api
        .videoResolve(bvid)
        .then((result) => {
          resolvedCache.set(bvid, result);
          if (alive) setInfo(result);
        })
        // 解析只是**补充**分 P / 可用画质，失败了照样能按当前参数下载。
        // 往行里塞一条错误反而会把真正该看的"下载失败"挤下去。
        .catch(() => undefined);
    });
    observer.observe(node);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [bvid, info]);

  const download = useCallback(async () => {
    setSending(true);
    setSendError("");
    try {
      const task = await api.videoDownload({
        bvid,
        page_index: pageIndex,
        max_height: effectiveHeight,
        audio_only: audioOnly,
        // 恒真，没有开关：不转码只是把 B 站的原始流直接封进容器，
        // Resolume / Final Cut / 一部分播放器打不开那种封装，下下来是废的。
        // 而且必须显式写 true——后端 apply_video_defaults 见 false 会当成"没指定"，
        // 落回全局设置里的 video_transcode（默认 false），等于这行白写。
        transcode: true,
      });
      // 和音频走同一个队列 store，右边那栏就是同一个 QueuePanel——
      // 任务当场出现在那里，就是"已加入队列"最好的回执
      mergeTasks([task]);
    } catch (error) {
      setSendError(`下载失败：${errorText(error)}`);
    } finally {
      setSending(false);
    }
  }, [bvid, pageIndex, effectiveHeight, audioOnly, mergeTasks]);

  return (
    <tr ref={rowRef} data-video="true">
      <td colSpan={colSpan}>
        {/* 没有单独的「预览」按钮：点行身任意留白（封面、标题、元信息）就在
            右栏开预览。分 P / 画质那些控件自己消费点击，closest 一挡就分开了。 */}
        <div
          className="kd-video-row"
          title="点击在右栏预览"
          onClick={(event) => {
            if (!bvid) return;
            if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
            requestVideoPreview({ bvid, title, author, page: pageIndex });
          }}
        >
          {/* 封面按 16:9 摆：视频封面本来就是宽的，裁成方块等于把画面切掉一半。
              尺寸由 CSS 写死，图片加载完不会把整行顶一下。 */}
          <span className="kd-video-cover">
            {cover && (
              <img
                src={cover}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            )}
          </span>

          <div className="kd-video-body">
            <div className="kd-video-title kd-truncate" title={title}>
              {title}
            </div>

            <div className="kd-video-meta">
              <span className="kd-truncate">{author || DASH}</span>
              <span>{formatDuration(duration)}</span>
              <span className="kd-mono">{bvid}</span>
              {/* 只在未登录时出声：高清晰度和会员视频拿不到，这时候才需要解释 */}
              {info && !info.logged_in && (
                <span
                  style={{ color: "var(--kd-warn)" }}
                  title="未登录：高清晰度和会员视频拿不到。去列表标签行最右边的「登录」扫码"
                >
                  未登录
                </span>
              )}
              {info && info.options.length > 0 && (
                <span className="kd-faint kd-truncate">
                  可用 {info.options.map((option) => option.label).join(" / ")}
                </span>
              )}
            </div>

            <div className="kd-video-controls">
              {pages.length > 1 && (
                <label className="kd-row" style={{ gap: "0.35rem" }}>
                  分 P
                  <select
                    className="kd-select"
                    data-size="sm"
                    data-pages="true"
                    value={pageIndex}
                    onChange={(event) => setPageIndex(Number(event.target.value))}
                  >
                    {pages.map((page) => (
                      <option key={page.index} value={page.index}>
                        P{page.index + 1} · {page.title} · {formatDuration(page.duration)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="kd-row" style={{ gap: "0.35rem" }}>
                画质
                <select
                  className="kd-select"
                  data-size="sm"
                  value={effectiveHeight}
                  disabled={audioOnly}
                  onChange={(event) => setMaxHeight(Number(event.target.value))}
                >
                  {HEIGHT_LADDER.map((height) => (
                    <option key={height} value={height}>
                      {height}p
                    </option>
                  ))}
                </select>
              </label>

              <label className="kd-row" style={{ gap: "0.35rem" }}>
                格式
                <select
                  className="kd-select"
                  data-size="sm"
                  value={audioOnly ? "m4a" : (settings?.video_format ?? "mp4")}
                  disabled={audioOnly}
                  onChange={(event) =>
                    void saveSettings({ video_format: event.target.value as VideoFormat })
                  }
                >
                  {audioOnly ? (
                    <option value="m4a">M4A</option>
                  ) : (
                    <>
                      <option value="mp4">MP4</option>
                      <option value="mkv">MKV</option>
                      <option value="mov">MOV</option>
                    </>
                  )}
                </select>
              </label>

              {/* 视频就是视频：默认下完整画面，这个勾才是"我这次只要声音" */}
              <label className="kd-check">
                <input
                  type="checkbox"
                  checked={audioOnly}
                  onChange={(event) => setAudioOnly(event.target.checked)}
                />
                <Music4 size={12} />
                只要音轨
              </label>

              {/* 「转码」开关删了，恒转码（见 download 里的注释）：这个勾唯一的用处是
                  换取速度，代价是有概率下到一个打不开的文件——赌注和收益不对等，
                  而且要下完拖进剪辑软件才发现输了。 */}

              <span className="kd-toolbar-gap" />
              {/* 中性而不是红：搜索一屏能出十几条视频行，每行一颗红按钮就是
                  十几个"强调"，等于没有强调。红色留给底部那颗批量入队的主按钮。 */}
              <Button size="sm" disabled={sending} onClick={() => void download()}>
                <Download size={12} />
                下载
              </Button>
            </div>

            <InlineNotice text={sendError} onDismiss={() => setSendError("")} />
          </div>
        </div>
      </td>
    </tr>
  );
}
