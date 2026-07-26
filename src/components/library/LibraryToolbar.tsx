import { useState } from "react";
import { Square } from "lucide-react";
import { forgetQueuedAnalysis } from "../../lib/autoAnalyze";
import { selectAnalyzing, useLibraryStore } from "../../stores/libraryStore";
import { Button, InlineNotice, ProgressBar } from "../common";

export function LibraryToolbar() {
  const cancelAnalyze = useLibraryStore((state) => state.cancelAnalyze);
  const scan = useLibraryStore((state) => state.scan);
  const analyze = useLibraryStore((state) => state.analyze);
  const analyzing = useLibraryStore(selectAnalyzing);
  /** 出错就地贴在工具条下面。原来是弹窗，可弹窗飘走之后用户就不知道刚才哪一步没成了。 */
  const [notice, setNotice] = useState("");
  /**
   * 已经关掉的那条导入失败提示，按 job_id 记。
   *
   * 失败原因是随 `scan.progress` 的终局事件回来的，它一直留在 store 里，
   * 所以不能靠 setState 清——组件下一次重渲染又会把它读回来。
   */
  const [dismissedScanJob, setDismissedScanJob] = useState("");

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
      {/* 筛选那一整条（调号 / BPM / 能量 / 重置）和「重新分析全部」都删了。
          理由分两半：
          · 筛选——真正在用的是右侧那个调号轮（点一格就按调筛曲库），
            一排输入框摆在列表头上，占了一整行却没人去填；
          · 重新分析全部——分析是这个软件自动该做的事（播放中插队 >
            可视区域+选中 > 空闲后台补齐），摆一颗按钮反而让人以为不点就不会分析。
          筛选状态本身没删：调号轮仍然能设，设了之后由列表头上的芯片负责显示和清除
          （见 Workspace 的 activeFilter），不然点完轮子就没有出口了。

          剩下这一段是**反馈**，不能跟着删：导入/分析的进度、失败原因、停止按钮。 */}
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
