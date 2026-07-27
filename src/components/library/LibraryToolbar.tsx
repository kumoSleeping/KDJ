import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  endTrackDrag,
  TRACK_DRAG_STATE_EVENT,
  TRACK_TRASH_DROP_EVENT,
  type TrackDragDetail,
} from "../../lib/trackDrag";
import { InlineNotice, ProgressBar } from "../common";

function AnalysisGlyph() {
  return (
    <svg className="kd-analysis-glyph" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2" y="6" width="2" height="6" />
      <rect x="6" y="3" width="2" height="12" />
      <rect x="10" y="5" width="2" height="8" />
      <rect x="14" y="7" width="2" height="4" />
      <circle className="kd-analysis-glyph-dot" cx="3" cy="15" r="1.25" />
    </svg>
  );
}

export function LibraryToolbar() {
  const scan = useLibraryStore((state) => state.scan);
  const analyze = useLibraryStore((state) => state.analyze);
  const filter = useLibraryStore((state) => state.filter);
  const queueView = useLibraryStore((state) => state.queueView);
  const keyFilter = filter.key;
  const setFilter = useLibraryStore((state) => state.setFilter);
  const [dragIds, setDragIds] = useState<number[]>([]);
  const [trashOver, setTrashOver] = useState(false);
  /** 出错就地贴在工具条下面。原来是弹窗，可弹窗飘走之后用户就不知道刚才哪一步没成了。 */
  const [notice, setNotice] = useState("");
  /**
   * 已经关掉的那条导入失败提示，按 job_id 记。
   *
   * 失败原因是随 `scan.progress` 的终局事件回来的，它一直留在 store 里，
   * 所以不能靠 setState 清——组件下一次重渲染又会把它读回来。
   */
  const [dismissedScanJob, setDismissedScanJob] = useState("");

  useEffect(() => {
    const onDragState = (event: Event) => {
      setDragIds((event as CustomEvent<TrackDragDetail>).detail?.ids ?? []);
      setTrashOver(false);
    };
    window.addEventListener(TRACK_DRAG_STATE_EVENT, onDragState);
    return () => window.removeEventListener(TRACK_DRAG_STATE_EVENT, onDragState);
  }, []);

  const energySteps: Array<number | null> = [null, 7, 8, 9, 10];
  const energyIndex = energySteps.indexOf(filter.energyMin);
  const nextEnergy = energySteps[(energyIndex + 1 + energySteps.length) % energySteps.length];
  const nextAnalyzed = filter.analyzed === "all" ? "yes" : filter.analyzed === "yes" ? "no" : "all";
  const hasFilter =
    Boolean(filter.key) ||
    filter.bpmMin !== null ||
    filter.bpmMax !== null ||
    filter.energyMin !== null ||
    filter.analyzed !== "all";

  const scanning = scan !== null && scan.phase !== "done";
  /**
   * 导入失败。`startScan` 的 Promise 只等到"任务起来了"，真正的失败发生在之后，
   * 所以 catch 不到——不看这条事件的话，界面上失败和"一首都没扫到"完全一样。
   */
  const importError =
    scan && scan.phase === "done" && scan.error && scan.job_id !== dismissedScanJob
      ? `添加文件夹失败：${scan.error}`
      : "";

  return (
    <>
      {(hasFilter || dragIds.length > 0) && <div className="kd-library-filterbar">
        <span className="kd-library-filter-label">筛选</span>
        <button
          type="button"
          className="kd-filter-control"
          data-active={keyFilter ? "true" : undefined}
          onClick={() => keyFilter && setFilter({ key: "" })}
          title={keyFilter ? "清除调号筛选" : "在右侧调号轮中选择调号"}
        >
          调号 {keyFilter || "全部"}
          {keyFilter && <span aria-hidden="true">×</span>}
        </button>
        <label className="kd-filter-range">
          <span>BPM</span>
          <input
            type="number"
            inputMode="numeric"
            value={filter.bpmMin ?? ""}
            placeholder="最低"
            aria-label="最低 BPM"
            onChange={(event) => setFilter({ bpmMin: event.target.value ? Number(event.target.value) : null })}
          />
          <span>–</span>
          <input
            type="number"
            inputMode="numeric"
            value={filter.bpmMax ?? ""}
            placeholder="最高"
            aria-label="最高 BPM"
            onChange={(event) => setFilter({ bpmMax: event.target.value ? Number(event.target.value) : null })}
          />
        </label>
        <button type="button" className="kd-filter-control" onClick={() => setFilter({ energyMin: nextEnergy })}>
          能量 {filter.energyMin === null ? "全部" : `≥ ${filter.energyMin}`}
        </button>
        <button type="button" className="kd-filter-control" onClick={() => setFilter({ analyzed: nextAnalyzed })}>
          {filter.analyzed === "all" ? "分析：全部" : filter.analyzed === "yes" ? "已分析" : "未分析"}
        </button>
        {hasFilter && (
          <button
            type="button"
            className="kd-filter-reset"
            title="清除上面四项筛选"
            onClick={() =>
              setFilter({ key: "", bpmMin: null, bpmMax: null, energyMin: null, analyzed: "all" })
            }
          >
            <RotateCcw size={11} />
            重置
          </button>
        )}
        <span className="kd-toolbar-gap" />
        {dragIds.length > 0 && (
          <div
            className="kd-track-trash-drop"
            data-over={trashOver ? "true" : undefined}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTrashOver(true);
            }}
            onDragLeave={() => setTrashOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              window.dispatchEvent(
                new CustomEvent<TrackDragDetail>(TRACK_TRASH_DROP_EVENT, { detail: { ids: dragIds } }),
              );
              endTrackDrag();
            }}
          >
            <Trash2 size={13} />
            {queueView ? "移出临时列表" : "移到废纸篓"}
          </div>
        )}
      </div>}
      {/* 用 analyze !== null 而不是 analyzing：后台补齐是一批 20 首连着跑的，
          跑完一批到下一批排上之间有个空档，按"在跑"算的话这一整行会闪一下，
          底下的曲目表跟着跳一次高度。跑完的那一批先停在 100% 上，
          确认后面没有下一批了才由 autoAnalyze 收走。 */}
      {(scanning || analyze !== null || notice || importError) && (
        <div className="kd-toolbar" style={{ gap: "0.75rem" }}>
          <InlineNotice className="kd-grow" text={notice} onDismiss={() => setNotice("")} />
          <InlineNotice
            className="kd-grow"
            text={importError}
            onDismiss={() => scan && setDismissedScanJob(scan.job_id)}
          />
          {scanning && scan && (
            <span className="kd-row kd-grow" style={{ gap: "0.5rem", minWidth: 0 }}>
              <ProgressBar
                className="kd-grow"
                value={scan.total > 0 ? scan.done / scan.total : 0}
                indeterminate={scan.total === 0}
              />
              <span className="kd-num kd-muted">
                {scan.done}/{scan.total}
              </span>
              <span className="kd-truncate kd-faint" style={{ maxWidth: "14rem" }} title={scan.current}>
                {scan.current}
              </span>
            </span>
          )}
          {analyze !== null && (
            <span className="kd-row kd-grow" style={{ gap: "0.5rem", minWidth: 0 }}>
              <AnalysisGlyph />
              <span className="kd-muted kd-truncate" title={analyze.current}>
                正在分析 {analyze.done}/{analyze.total} 首{analyze.current ? ` · ${analyze.current}` : ""}
              </span>
            </span>
          )}
        </div>
      )}
    </>
  );
}
