import {
  Columns2,
  Download,
  Settings,
  Upload,
} from "lucide-react";
import { useUpdateStore } from "../../stores/updateStore";

export type AsideToggleState = "open" | "closed" | "locked";

export interface ChromeActionsProps {
  middleSplitEnabled: boolean;
  onMiddleSplit(): void;
  settingsOpen: boolean;
  onSettings(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
  /** 打开设置并定位到软件更新区；默认走 updateStore。 */
  onOpenUpdate?(): void;
}

/** 主栏顶部右侧的设置、下载入口。右栏收起按钮已移到右栏头部。 */
export function ChromeActions({
  middleSplitEnabled,
  onMiddleSplit,
  settingsOpen,
  onSettings,
  queueOpen,
  queueCount,
  onQueue,
  onOpenUpdate,
}: ChromeActionsProps) {
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const latest = useUpdateStore((s) => s.info?.latest ?? "");
  const openUpdateSection = useUpdateStore((s) => s.openUpdateSection);
  const openUpdate = onOpenUpdate ?? openUpdateSection;

  return (
    <div className="kd-chrome-actions" role="group" aria-label="顶栏工具">
      {updateReady ? (
        <button
          type="button"
          className="kd-chrome-btn"
          data-update="true"
          aria-label={latest ? `有新版本 v${latest} 待下载` : "有更新待下载"}
          title={latest ? `待下载：v${latest}` : "待下载更新"}
          data-open={settingsOpen || undefined}
          onClick={openUpdate}
        >
          {/* 经典「上箭头 + 底框」升级形；灰色，有更新只靠角点提示。 */}
          <Upload size={16} />
          <span className="kd-chrome-dot" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        className="kd-chrome-btn"
        data-action="middle-split"
        data-active={middleSplitEnabled ? "true" : undefined}
        aria-pressed={middleSplitEnabled}
        aria-label={middleSplitEnabled ? "关闭中间分屏模式" : "打开中间分屏模式"}
        title={
          middleSplitEnabled
            ? "分屏模式已开启：本地与在线内容同时显示"
            : "分屏模式已关闭：只显示当前使用的内容"
        }
        onClick={onMiddleSplit}
      >
        <Columns2 size={16} />
      </button>
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label="设置"
        aria-pressed={settingsOpen}
        data-open={settingsOpen || undefined}
        title="设置：接播与账号"
        onClick={onSettings}
      >
        <Settings size={16} />
      </button>
      <button
        type="button"
        className="kd-chrome-btn"
        data-queue-hint={queueCount > 0 ? "true" : undefined}
        aria-label={queueCount > 0 ? `下载队列，${queueCount} 个进行中` : "下载队列"}
        aria-pressed={queueOpen}
        data-open={queueOpen || undefined}
        title={queueCount > 0 ? `下载队列（${queueCount} 进行中）` : "下载队列"}
        onClick={onQueue}
      >
        <Download size={16} />
        {queueCount > 0 ? <span className="kd-chrome-dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
