import { useState } from "react";
import { Activity, FolderPlus, RotateCcw, Square } from "lucide-react";
import { forgetQueuedAnalysis } from "../../lib/autoAnalyze";
import { CAMELOT_ORDER, camelotToLabel } from "../../lib/camelot";
import { selectAnalyzing, useLibraryStore } from "../../stores/libraryStore";
import { Button, InlineNotice, ProgressBar } from "../common";

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
  const setAutoAnalyzeSuspended = useLibraryStore((state) => state.setAutoAnalyzeSuspended);
  const scan = useLibraryStore((state) => state.scan);
  const analyze = useLibraryStore((state) => state.analyze);
  const analyzing = useLibraryStore(selectAnalyzing);
  const stats = useLibraryStore((state) => state.stats);
  /** 出错就地贴在工具条下面。原来是弹窗，可弹窗飘走之后用户就不知道刚才哪一步没成了。 */
  const [notice, setNotice] = useState("");

  const scanning = scan !== null && scan.phase !== "done";
  const pending = stats ? stats.total - stats.analyzed : 0;

  /**
   * 「添加文件夹」是一个动作，不是一次作业：选完目录之后登记曲库根、扫描、
   * 把新曲目排进分析队列这三件事全在后台自动做完，用户不需要再点第二下。
   * 所以 analyze 恒为 true——它是这个动作语义的一部分，不是可选项。
   */
  const addFolders = async () => {
    const paths = await window.kumodeck?.pickFolders();
    if (!paths || paths.length === 0) return;
    setNotice("");
    try {
      await startScan(paths, true);
    } catch (error) {
      setNotice(`添加文件夹失败：${(error as Error).message}`);
    }
  };

  /**
   * 平时不用点这里：选中、播放、以及空闲时的后台补齐已经在自动排队了。
   * 这个按钮是「现在就全部排上」的快捷方式，同时也是按过「停止」之后
   * 把自动化重新点亮的开关——所以要先清掉排过队的记号，被取消的那些才排得回去。
   */
  const analyzePending = async () => {
    setNotice("");
    forgetQueuedAnalysis();
    setAutoAnalyzeSuspended(false);
    try {
      await startAnalyze(null, false);
    } catch (error) {
      setNotice(`分析失败：${(error as Error).message}`);
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

        {/* 「已分析 / 未分析」筛选已删除：分析是后台自动跑完的，
            没有哪个 DJ 会想按"这首分析过了没"来找歌。
            `AnalyzedFilter` 类型和 store 里的字段保留着——
            后台补齐队列仍然要靠它查未分析的曲目。 */}

        <Button variant="ghost" size="sm" iconOnly aria-label="重置筛选" onClick={resetFilter}>
          <RotateCcw size={12} />
        </Button>

        <span className="kd-toolbar-gap" />

        <Button
          onClick={() => void addFolders()}
          disabled={scanning}
          title="选一个文件夹加进曲库，导入和分析都在后台自动做完"
        >
          <FolderPlus size={13} />
          添加文件夹
        </Button>
        {/* 停止不在这儿：它就贴在下面那条分析进度条旁边——要停的是那根进度条，
            按钮离它一行远的话，得先确认"我停的是哪个"。
            这里也不用红色：它和顶上的「搜索」会叠成两个常亮的红块。 */}
        <Button
          onClick={() => void analyzePending()}
          disabled={pending <= 0 || analyzing}
          title="立刻把所有还没跑过的曲目全排上（平时它们会在空闲时慢慢补齐）"
        >
          <Activity size={13} />
          分析{pending > 0 ? `（${pending}）` : ""}
        </Button>
      </div>

      {/* 用 analyze !== null 而不是 analyzing：后台补齐是一批 20 首连着跑的，
          跑完一批到下一批排上之间有个空档，按"在跑"算的话这一整行会闪一下，
          底下的曲目表跟着跳一次高度。跑完的那一批先停在 100% 上，
          确认后面没有下一批了才由 autoAnalyze 收走。 */}
      {(scanning || analyze !== null || notice) && (
        <div className="kd-toolbar" style={{ gap: "0.75rem" }}>
          <InlineNotice className="kd-grow" text={notice} onDismiss={() => setNotice("")} />
          {scanning && scan && (
            <span className="kd-row kd-grow" style={{ gap: "0.5rem", minWidth: 0 }}>
              {/* 用户点的是「添加文件夹」，进度条上就不该冒出一个他没听说过的"扫描" */}
              <span className="kd-chip" data-tone="theme">
                导入
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
          {analyze !== null && (
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
              {/* 分析上千首要跑很久，中途改主意必须能停下来——不给出口的话
                  只能关掉整个 app，正在写的那一行还可能写坏。
                  就地贴在进度条尾巴上：停的是眼前这根条，不用再去别处找按钮。
                  这一行唯一的红色，而且只在真的有东西在跑时才出现。 */}
              {analyzing && (
                <Button
                  variant="danger"
                  size="sm"
                  iconOnly
                  aria-label="停止分析"
                  title="停止分析。正在跑的那一首会跑完，之后也不再自动补齐"
                  onClick={() => {
                    forgetQueuedAnalysis();
                    void cancelAnalyze().catch((error: unknown) =>
                      setNotice((error as Error).message),
                    );
                  }}
                >
                  <Square size={10} fill="currentColor" />
                </Button>
              )}
            </span>
          )}
        </div>
      )}
    </>
  );
}
