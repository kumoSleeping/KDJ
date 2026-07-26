import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Download, LoaderCircle, Music4 } from "lucide-react";
import { api } from "../../lib/api";
import { DASH, formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { VideoFormat, VideoInfo } from "../../types";
import { Button, EmptyState, InlineNotice } from "../common";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 视频模式下的正文。
 *
 * 视频不再是并列的板块：它和音乐做的是同一件事（找一条流、下载、可能进曲库），
 * 所以共用顶上那条搜索框、右边那个队列。这里只负责"解析出来的这个视频长什么样、
 * 要下哪一档"。链接从工作台传进来，回车即解析。
 */
export function VideoPanel({ query, busy }: { query: string; busy: boolean }) {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const mergeTasks = useDownloadStore((state) => state.mergeTasks);

  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sending, setSending] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  /** 解析失败的原因：没有 info 时整块面板是空的，得由它来解释为什么空。 */
  const [resolveError, setResolveError] = useState("");
  /** 入队失败的原因，贴在「加入队列」底下。 */
  const [sendError, setSendError] = useState("");

  const effectiveHeight = maxHeight ?? settings?.video_max_height ?? 1080;

  const resolve = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setResolving(true);
    setResolveError("");
    setSendError("");
    try {
      const result = await api.videoResolve(text.trim());
      setInfo(result);
      setPageIndex(0);
      // 未登录不再弹一次窗：下面那行元信息里就写着"未登录"，
      // 鼠标停上去有完整说明，说两遍反而像出了两件事
    } catch (error) {
      setInfo(null);
      setResolveError(`解析失败：${errorText(error)}`);
    } finally {
      setResolving(false);
    }
  }, []);

  // 工作台按下搜索时会把 busy 打开，借这个沿触发解析——
  // 视频只有"解析"一种动作，没必要再单独给它一个按钮。
  useEffect(() => {
    if (busy) void resolve(query);
    // query 不进依赖：只在提交那一刻取当前值，边打字边解析没有意义
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const download = useCallback(async () => {
    if (!info) return;
    setSending(true);
    setSendError("");
    try {
      const task = await api.videoDownload({
        bvid: info.bvid,
        page_index: pageIndex,
        max_height: effectiveHeight,
        audio_only: audioOnly,
        transcode: settings?.video_transcode ?? false,
      });
      // 和音频走同一个队列 store，右边那栏是同一个 QueuePanel——
      // 任务当场出现在那里，就是"已加入队列"最好的回执
      mergeTasks([task]);
    } catch (error) {
      setSendError(`下载失败：${errorText(error)}`);
    } finally {
      setSending(false);
    }
  }, [info, pageIndex, effectiveHeight, audioOnly, settings, mergeTasks]);

  if (resolving) {
    return <EmptyState icon={<LoaderCircle className="kd-spin" size={22} />} title="正在解析" />;
  }
  if (!info) {
    // 解析失败时这块空面板就是唯一的现场，原因写在这儿最省事
    return (
      <EmptyState
        icon={<Clapperboard size={22} />}
        title={resolveError ? "没解析出来" : "粘贴一个 B 站链接或 BV 号"}
        hint={resolveError || undefined}
      />
    );
  }

  return (
    <div className="kd-scroll kd-pad" style={{ height: "100%" }}>
      <div className="kd-row" style={{ gap: "1rem", alignItems: "flex-start" }}>
        {info.cover && (
          <img
            className="kd-cover"
            style={{ width: 200, height: 125 }}
            src={info.cover}
            alt=""
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.visibility = "hidden";
            }}
          />
        )}
        <div className="kd-col kd-grow" style={{ gap: "0.5rem", minWidth: 0 }}>
          <div className="kd-truncate" style={{ fontWeight: 700, fontSize: "var(--kd-size-lg)" }}>
            {info.title}
          </div>
          <div className="kd-row kd-faint" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
            <span>{info.author || DASH}</span>
            <span>{formatDuration(info.duration)}</span>
            <span className="kd-mono">{info.bvid}</span>
            <span
              style={{ color: info.logged_in ? undefined : "var(--kd-warn)" }}
              title={
                info.logged_in
                  ? undefined
                  : "未登录：高清晰度和会员视频拿不到。去列表标签行最右边的「登录」扫码"
              }
            >
              {info.logged_in ? "已登录" : "未登录"}
            </span>
          </div>

          {info.pages.length > 1 && (
            <label className="kd-row kd-muted" style={{ gap: "0.4rem" }}>
              分 P
              <select
                className="kd-select kd-grow"
                value={pageIndex}
                onChange={(event) => setPageIndex(Number(event.target.value))}
              >
                {info.pages.map((page) => (
                  <option key={page.index} value={page.index}>
                    P{page.index + 1} · {page.title} · {formatDuration(page.duration)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="kd-row kd-muted" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
            <label className="kd-row" style={{ gap: "0.35rem" }}>
              画质
              <select
                className="kd-select"
                value={effectiveHeight}
                disabled={audioOnly}
                onChange={(event) => setMaxHeight(Number(event.target.value))}
              >
                {[2160, 1440, 1080, 720, 480, 360].map((height) => (
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
            <label className="kd-check">
              <input
                type="checkbox"
                checked={audioOnly}
                onChange={(event) => setAudioOnly(event.target.checked)}
              />
              <Music4 size={12} />
              只要音轨
            </label>
          </div>

          {info.options.length > 0 && (
            <div className="kd-faint kd-truncate">
              可用 {info.options.map((option) => option.label).join(" / ")}
            </div>
          )}

          <div className="kd-row">
            <Button variant="primary" disabled={sending} onClick={() => void download()}>
              <Download size={13} />
              加入队列
            </Button>
          </div>
          <InlineNotice text={sendError} onDismiss={() => setSendError("")} />
        </div>
      </div>
    </div>
  );
}
