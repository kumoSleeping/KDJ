import { ArrowDown, ArrowUp, Check, Clapperboard, Film } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useVjExportStore, type VjExportQuality } from "../../stores/vjExportStore";
import { Button, InlineNotice, Panel, PanelStack } from "../common";

const QUALITIES: { id: VjExportQuality; label: string }[] = [
  { id: "1080p", label: "1080p" },
  { id: "720p", label: "720p" },
  { id: "480p", label: "480p" },
];

function CheckRow({
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint?: string;
  onChange(value: boolean): void;
}) {
  return (
    <div className="kd-col" style={{ gap: "0.15rem" }}>
      <label className="kd-djp-check" data-disabled={disabled ? "true" : undefined}>
        <span className="kd-djp-check-box" data-on={checked ? "true" : undefined} aria-hidden="true">
          {checked ? <Check size={11} strokeWidth={2.5} /> : null}
        </span>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        {label}
      </label>
      {hint ? <p className="kd-djp-note">{hint}</p> : null}
    </div>
  );
}

/**
 * 文件夹「按顺序导出 VJ」的右栏设置面板。
 * 「开始导出」入下载队列统一管理，由后端 FFmpeg 渲染成一条片子。
 */
export function VjExportPanel() {
  const folder = useVjExportStore((state) => state.folder);
  const tracks = useVjExportStore((state) => state.tracks);
  const orderedIds = useVjExportStore((state) => state.orderedIds);
  const loading = useVjExportStore((state) => state.loading);
  const error = useVjExportStore((state) => state.error);
  const useInOutPoints = useVjExportStore((state) => state.useInOutPoints);
  const snapNearestBeat = useVjExportStore((state) => state.snapNearestBeat);
  const snapWholeBar = useVjExportStore((state) => state.snapWholeBar);
  const fadeMode = useVjExportStore((state) => state.fadeMode);
  const fadeSeconds = useVjExportStore((state) => state.fadeSeconds);
  const fadeBars = useVjExportStore((state) => state.fadeBars);
  const quality = useVjExportStore((state) => state.quality);
  const keepAudio = useVjExportStore((state) => state.keepAudio);
  const unifyGain = useVjExportStore((state) => state.unifyGain);
  const moveTrack = useVjExportStore((state) => state.moveTrack);
  const setUseInOutPoints = useVjExportStore((state) => state.setUseInOutPoints);
  const setSnapNearestBeat = useVjExportStore((state) => state.setSnapNearestBeat);
  const setSnapWholeBar = useVjExportStore((state) => state.setSnapWholeBar);
  const setFadeMode = useVjExportStore((state) => state.setFadeMode);
  const setFadeSeconds = useVjExportStore((state) => state.setFadeSeconds);
  const setFadeBars = useVjExportStore((state) => state.setFadeBars);
  const setQuality = useVjExportStore((state) => state.setQuality);
  const setKeepAudio = useVjExportStore((state) => state.setKeepAudio);
  const setUnifyGain = useVjExportStore((state) => state.setUnifyGain);

  const mergeTasks = useDownloadStore((state) => state.mergeTasks);
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);

  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const byId = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const ordered = orderedIds.map((id) => byId.get(id)).filter((track): track is NonNullable<typeof track> => !!track);
  const folderName = folder.split("/").filter(Boolean).pop() || folder;

  const startExport = async () => {
    if (ordered.length === 0 || submitting) return;
    setSubmitting(true);
    setNotice("");
    try {
      const task = await api.vjExport({
        folder,
        track_ids: ordered.map((track) => track.id),
        use_in_out_points: useInOutPoints,
        snap_nearest_beat: snapNearestBeat,
        snap_whole_bar: snapWholeBar,
        fade_seconds: fadeMode === "seconds" ? fadeSeconds : 0,
        fade_bars: fadeMode === "bars" ? fadeBars : 0,
        quality,
        keep_audio: keepAudio,
        unify_gain: unifyGain,
      });
      mergeTasks([task]);
      openQueuePanel();
      setNotice("已加入导出队列；完成后可从任务条目打开成品路径。");
    } catch (reason: unknown) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-scroll kd-djp" style={{ minHeight: 0 }}>
        <PanelStack storageKey="kd-vj-export-panels">
          <Panel key="meta" heading="导出目标" dense>
            <p className="kd-djp-note" style={{ margin: 0 }}>
              文件夹 <strong>{folderName}</strong>
              {ordered.length > 0 ? ` · ${ordered.length} 首` : ""}
            </p>
            {loading ? <p className="kd-djp-note">正在读取曲目…</p> : null}
            {error ? <InlineNotice text={error} /> : null}
          </Panel>

          <Panel key="order" heading="曲目顺序" dense>
            {ordered.length === 0 && !loading ? (
              <p className="kd-djp-note">这个文件夹里还没有曲目。</p>
            ) : (
              <ul className="kd-vj-export-list">
                {ordered.map((track, index) => (
                  <li key={track.id} className="kd-vj-export-row">
                    <span className="kd-vj-export-idx">{index + 1}</span>
                    <span className="kd-vj-export-title" title={track.title || track.filename}>
                      {track.title || track.filename}
                    </span>
                    <span className="kd-faint kd-nowrap">
                      {formatDuration(track.duration)}
                    </span>
                    <span className="kd-vj-export-move">
                      <button
                        type="button"
                        aria-label="上移"
                        disabled={index === 0}
                        onClick={() => moveTrack(track.id, -1)}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="下移"
                        disabled={index === ordered.length - 1}
                        onClick={() => moveTrack(track.id, 1)}
                      >
                        <ArrowDown size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="kd-djp-note">仅影响本次导出，不会改曲库里的手排顺序。</p>
          </Panel>

          <Panel key="crop" heading="裁切与对齐" dense>
            <div className="kd-col" style={{ gap: "0.55rem" }}>
              <CheckRow
                checked={useInOutPoints}
                label="使用开始 / 结束点"
                hint="开启后按每首的进出点裁切；缺省端退回曲头或曲尾。"
                onChange={setUseInOutPoints}
              />
              <CheckRow
                checked={snapNearestBeat}
                disabled={snapWholeBar}
                label="严格依照就近拍线"
                hint={
                  snapWholeBar
                    ? "已开启整节线，起止会先对齐到拍。"
                    : "把起止吸附到最近一拍（需要 BPM / 首拍）。"
                }
                onChange={setSnapNearestBeat}
              />
              <CheckRow
                checked={snapWholeBar}
                label="整节线"
                hint="再抬到整小节（4 拍一小节）；开启时隐含拍对齐。"
                onChange={setSnapWholeBar}
              />
            </div>
          </Panel>

          <Panel key="fade" heading="淡入淡出" dense>
            <div className="kd-col" style={{ gap: "0.5rem" }}>
              <div className="kd-djp-segs" role="radiogroup" aria-label="淡入淡出单位">
                <button
                  type="button"
                  role="radio"
                  aria-checked={fadeMode === "bars"}
                  data-on={fadeMode === "bars" ? "true" : undefined}
                  onClick={() => setFadeMode("bars")}
                >
                  按小节
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={fadeMode === "seconds"}
                  data-on={fadeMode === "seconds" ? "true" : undefined}
                  onClick={() => setFadeMode("seconds")}
                >
                  按秒
                </button>
              </div>
              {fadeMode === "bars" ? (
                <label className="kd-djp-number">
                  <span>衔接小节</span>
                  <input
                    className="kd-input"
                    type="number"
                    min="0"
                    max="32"
                    step="1"
                    value={fadeBars}
                    onChange={(event) => setFadeBars(Number(event.currentTarget.value))}
                  />
                </label>
              ) : (
                <label className="kd-djp-number">
                  <span>衔接秒数</span>
                  <input
                    className="kd-input"
                    type="number"
                    min="0"
                    max="120"
                    step="0.1"
                    value={fadeSeconds}
                    onChange={(event) => setFadeSeconds(Number(event.currentTarget.value))}
                  />
                </label>
              )}
              <p className="kd-djp-note">
                {fadeMode === "bars"
                  ? "每次衔接以上一首 VJ 的 BPM 换算；未分析的素材按 120 BPM。设为 0 即硬切。"
                  : "所有衔接使用相同秒数；设为 0 即硬切。"}
              </p>
            </div>
          </Panel>

          <Panel key="quality" heading="输出质量" dense>
            <div className="kd-djp-segs" role="radiogroup" aria-label="输出质量">
              {QUALITIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={item.id === quality}
                  data-on={item.id === quality ? "true" : undefined}
                  onClick={() => setQuality(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </Panel>

          <Panel key="audio" heading="音频" dense>
            <div className="kd-col" style={{ gap: "0.55rem" }}>
              <CheckRow
                checked={keepAudio}
                label="保留音频"
                hint="关闭则导出无声画面。"
                onChange={setKeepAudio}
              />
              <CheckRow
                checked={unifyGain}
                disabled={!keepAudio}
                label="统一增益"
                hint="按响度把各曲增益拉齐（导出时生效）。"
                onChange={setUnifyGain}
              />
            </div>
          </Panel>

          <Panel key="actions" heading="导出" dense>
            <div className="kd-col" style={{ gap: "0.45rem" }}>
              <Button
                type="button"
                disabled={ordered.length === 0 || loading || submitting}
                onClick={() => void startExport()}
              >
                <Clapperboard size={14} />
                {submitting ? "加入队列…" : "开始导出 VJ"}
              </Button>
              <Button type="button" disabled title="即将支持：把整段 DJ 混音渲成一条片子">
                <Film size={14} />
                导出整段混音
              </Button>
              {notice ? (
                <InlineNotice text={notice} onDismiss={() => setNotice("")} />
              ) : null}
            </div>
          </Panel>
        </PanelStack>
      </div>
    </div>
  );
}
