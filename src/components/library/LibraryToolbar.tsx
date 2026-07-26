import { Activity, FolderPlus, RotateCcw, Square } from "lucide-react";
import { CAMELOT_ORDER, camelotToLabel } from "../../lib/camelot";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore, type AnalyzedFilter } from "../../stores/libraryStore";
import { Button, ProgressBar } from "../common";

const ANALYZED_OPTIONS: ReadonlyArray<{ id: AnalyzedFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "yes", label: "已分析" },
  { id: "no", label: "未分析" },
];

/** 输入框里的数字：空串 → null，非法 → 保持原值不动。 */
function parseNumber(raw: string): number | null | undefined {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function LibraryToolbar() {
  const filter = useLibraryStore((state) => state.filter);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const resetFilter = useLibraryStore((state) => state.resetFilter);
  const startScan = useLibraryStore((state) => state.startScan);
  const startAnalyze = useLibraryStore((state) => state.startAnalyze);
  const cancelAnalyze = useLibraryStore((state) => state.cancelAnalyze);
  const scan = useLibraryStore((state) => state.scan);
  const analyze = useLibraryStore((state) => state.analyze);
  const stats = useLibraryStore((state) => state.stats);
  const pushToast = useAppStore((state) => state.pushToast);
  const autoAnalyze = useAppStore((state) => state.settings?.auto_analyze ?? true);

  const scanning = scan !== null && scan.phase !== "done";
  const analyzing = analyze !== null && (analyze.total === 0 || analyze.done < analyze.total);
  const pending = stats ? stats.total - stats.analyzed : 0;

  const pickAndScan = async () => {
    const paths = await window.kumodeck?.pickFolders();
    if (!paths || paths.length === 0) return;
    try {
      const response = await startScan(paths, autoAnalyze);
      pushToast("info", `开始扫描 ${paths.length} 个目录，发现 ${response.found} 个文件`);
    } catch (error) {
      pushToast("error", `扫描失败：${(error as Error).message}`);
    }
  };

  const analyzePending = async () => {
    try {
      const response = await startAnalyze(null, false);
      pushToast(
        response.queued > 0 ? "info" : "warn",
        response.queued > 0 ? `已排队分析 ${response.queued} 首` : "没有待分析的曲目",
      );
    } catch (error) {
      pushToast("error", `分析失败：${(error as Error).message}`);
    }
  };

  return (
    <>
      <div className="kd-toolbar">
        {/* 曲库的文字搜索挪到左边文件夹栏顶上了：顶上那条大搜索框是"搜网上的歌"，
            两个搜索并排放会让人分不清哪个是哪个。 */}
        <select
          className="kd-select"
          value={filter.key}
          aria-label="按调号筛选"
          onChange={(event) => setFilter({ key: event.target.value })}
        >
          <option value="">全部调号</option>
          {CAMELOT_ORDER.map((code) => (
            <option key={code} value={code}>
              {code} · {camelotToLabel(code)}
            </option>
          ))}
        </select>

        <span className="kd-row kd-muted" style={{ gap: "0.25rem" }}>
          BPM
          <input
            className="kd-input"
            style={{ width: "4rem" }}
            type="number"
            value={filter.bpmMin ?? ""}
            placeholder="最低"
            aria-label="BPM 下限"
            onChange={(event) => {
              const value = parseNumber(event.target.value);
              if (value !== undefined) setFilter({ bpmMin: value });
            }}
          />
          <span className="kd-faint">–</span>
          <input
            className="kd-input"
            style={{ width: "4rem" }}
            type="number"
            value={filter.bpmMax ?? ""}
            placeholder="最高"
            aria-label="BPM 上限"
            onChange={(event) => {
              const value = parseNumber(event.target.value);
              if (value !== undefined) setFilter({ bpmMax: value });
            }}
          />
        </span>

        <span className="kd-row kd-muted" style={{ gap: "0.25rem" }}>
          能量≥
          <input
            className="kd-input"
            style={{ width: "3.5rem" }}
            type="number"
            min={1}
            max={10}
            value={filter.energyMin ?? ""}
            aria-label="能量下限"
            onChange={(event) => {
              const value = parseNumber(event.target.value);
              if (value !== undefined) setFilter({ energyMin: value });
            }}
          />
        </span>

        <div className="kd-segment" role="group" aria-label="分析状态">
          {ANALYZED_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter.analyzed === option.id}
              onClick={() => setFilter({ analyzed: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>

        <Button variant="ghost" size="sm" iconOnly aria-label="重置筛选" onClick={resetFilter}>
          <RotateCcw size={12} />
        </Button>

        <span className="kd-toolbar-gap" />

        <Button onClick={() => void pickAndScan()} disabled={scanning}>
          <FolderPlus size={13} />
          扫描目录
        </Button>
        {analyzing ? (
          // 分析上千首要跑很久，中途改主意必须能停下来——不给出口的话
          // 只能关掉整个 app，正在写的那一行还可能写坏。
          <Button
            variant="danger"
            onClick={() => {
              void cancelAnalyze()
                .then(() => pushToast("info", "已停止分析"))
                .catch((error: unknown) => pushToast("error", (error as Error).message));
            }}
            title="停止批量分析。正在跑的那一首会跑完"
          >
            <Square size={11} fill="currentColor" />
            停止分析
          </Button>
        ) : (
          // 不用红色：它和顶上的「搜索」会叠成两个常亮的红块。
          // 分析是曲库的日常动作，中性按钮 + 数字够醒目了。
          <Button
            onClick={() => void analyzePending()}
            disabled={pending <= 0}
            title="分析所有还没跑过的曲目"
          >
            <Activity size={13} />
            分析{pending > 0 ? `（${pending}）` : ""}
          </Button>
        )}
      </div>

      {(scanning || analyzing) && (
        <div className="kd-toolbar" style={{ gap: "0.75rem" }}>
          {scanning && scan && (
            <span className="kd-row kd-grow" style={{ gap: "0.5rem", minWidth: 0 }}>
              <span className="kd-chip" data-tone="theme">
                扫描
              </span>
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
          {analyzing && analyze && (
            <span className="kd-row kd-grow" style={{ gap: "0.5rem", minWidth: 0 }}>
              <span className="kd-chip" data-tone="theme">
                分析
              </span>
              <ProgressBar
                className="kd-grow"
                value={analyze.total > 0 ? analyze.done / analyze.total : 0}
                indeterminate={analyze.total === 0}
              />
              <span className="kd-num kd-muted">
                {analyze.done}/{analyze.total}
              </span>
              <span className="kd-truncate kd-faint" style={{ maxWidth: "14rem" }} title={analyze.current}>
                {analyze.current}
              </span>
            </span>
          )}
        </div>
      )}
    </>
  );
}
