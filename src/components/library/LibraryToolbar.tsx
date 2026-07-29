import { useEffect, useState } from "react";
import { CheckSquare, Copy, ListMusic, RotateCcw, Scissors, Search, Trash2, X } from "lucide-react";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  finishTrackDrop,
  TRACK_DRAG_STATE_EVENT,
  TRACK_TRASH_DROP_EVENT,
  type TrackDragDetail,
} from "../../lib/trackDrag";
import { Button, InlineNotice } from "../common";
import { WorkRailSelection } from "../chrome/WorkRail";

export function LibraryToolbar() {
  const scan = useLibraryStore((state) => state.scan);
  const filter = useLibraryStore((state) => state.filter);
  const queueView = useLibraryStore((state) => state.queueView);
  const keyFilter = filter.key;
  const setFilter = useLibraryStore((state) => state.setFilter);
  const selectedIds = useLibraryStore((state) => state.selectedIds);
  const selectionMode = useLibraryStore((state) => state.selectionMode);
  const setSelectionMode = useLibraryStore((state) => state.setSelectionMode);
  const copyToClipboard = useLibraryStore((state) => state.copyToClipboard);
  const total = useLibraryStore((state) => state.total);
  const selecting = selectionMode || selectedIds.length > 1;
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
      <div className="kd-library-commandbar" data-selecting={selecting ? "true" : undefined}>
        {selecting ? (
          <div className="kd-library-command-actions">
            <CheckSquare size={13} strokeWidth={2.25} aria-hidden="true" />
            <WorkRailSelection
              count={selectedIds.length}
              onSelectAll={() => useLibraryStore.getState().selectAll()}
              onClear={() => useLibraryStore.getState().select(null)}
              onDone={() => {
                setSelectionMode(false);
                useLibraryStore.getState().select(null);
              }}
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={selectedIds.length === 0}
                    onClick={() => copyToClipboard("link")}
                  >
                    <Copy size={12} /> 复制
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={selectedIds.length === 0}
                    onClick={() => copyToClipboard("move")}
                  >
                    <Scissors size={12} /> 剪切
                  </Button>
                </>
              }
            />
          </div>
        ) : !queueView ? (
          <label className="kd-library-inline-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              value={filter.q}
              placeholder={filter.folder ? "在当前文件夹中搜索" : "在全部歌曲中搜索"}
              aria-label={filter.folder ? "搜索当前文件夹的曲目名称" : "搜索全部曲目的名称"}
              onChange={(event) => setFilter({ q: event.target.value })}
            />
            {filter.q && (
              <button
                type="button"
                aria-label="清除曲目搜索"
                title="清除曲目搜索"
                onClick={() => setFilter({ q: "" })}
              >
                <X size={12} />
              </button>
            )}
          </label>
        ) : (
          <div className="kd-library-command-actions">
            <ListMusic size={13} aria-hidden="true" />
            <span>临时列表 {total} 首</span>
          </div>
        )}
      </div>
      {hasFilter && (
        <div className="kd-library-filterbar">
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
              onChange={(event) =>
                setFilter({ bpmMin: event.target.value ? Number(event.target.value) : null })
              }
            />
            <span>–</span>
            <input
              type="number"
              inputMode="numeric"
              value={filter.bpmMax ?? ""}
              placeholder="最高"
              aria-label="最高 BPM"
              onChange={(event) =>
                setFilter({ bpmMax: event.target.value ? Number(event.target.value) : null })
              }
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
        </div>
      )}
      {/*
        这个落点必须常驻并脱离文档流。旧实现会在 dragstart 后临时插入整条筛选栏，
        把作为拖动源的表格向下挤；WKWebView 随后会截到筛选栏/表头作为拖动预览，
        严重时还会取消本应落到左侧文件夹的 drop。

        常驻节点只切 visibility，不在拖动过程中挂载、卸载或改变表格几何位置。
      */}
      <div
        className="kd-track-trash-drop"
        data-kd-track-trash-target="true"
        data-visible={dragIds.length > 0 ? "true" : undefined}
        data-over={trashOver ? "true" : undefined}
        aria-hidden={dragIds.length === 0}
        onDragOver={(event) => {
          if (dragIds.length === 0) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setTrashOver(true);
        }}
        onDragLeave={() => setTrashOver(false)}
        onDrop={(event) => {
          if (dragIds.length === 0) return;
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent<TrackDragDetail>(TRACK_TRASH_DROP_EVENT, { detail: { ids: dragIds } }),
          );
          finishTrackDrop();
        }}
      >
        <Trash2 size={13} />
        {queueView ? "移出临时列表" : "移到废纸篓"}
      </div>
      {(notice || importError) && (
        <div className="kd-toolbar" style={{ gap: "0.75rem" }}>
          <InlineNotice className="kd-grow" text={notice} onDismiss={() => setNotice("")} />
          <InlineNotice
            className="kd-grow"
            text={importError}
            onDismiss={() => scan && setDismissedScanJob(scan.job_id)}
          />
        </div>
      )}
    </>
  );
}
