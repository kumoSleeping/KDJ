import {
  ArrowUpCircle,
  Download,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  Settings,
} from "lucide-react";
import { useUpdateStore } from "../../stores/updateStore";

export type AsideToggleState = "open" | "closed" | "locked";

export interface ChromeActionsProps {
  settingsOpen: boolean;
  onSettings(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
  /** 横屏保留右栏开关；竖屏内容走抽屉，不显示这颗按钮。 */
  showAsideToggle?: boolean;
  asideState: AsideToggleState;
  onAsideToggle(): void;
}

/** 主栏顶部右侧的设置、下载及横屏侧栏入口。 */
export function ChromeActions({
  settingsOpen,
  onSettings,
  queueOpen,
  queueCount,
  onQueue,
  showAsideToggle = true,
  asideState,
  onAsideToggle,
}: ChromeActionsProps) {
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const latest = useUpdateStore((s) => s.info?.latest ?? "");
  const openUpdateSection = useUpdateStore((s) => s.openUpdateSection);

  const asideLabel =
    asideState === "open"
      ? "关闭右侧栏"
      : asideState === "closed"
        ? "锁定右侧栏自动展开"
        : "解除右侧栏锁定";

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
          onClick={openUpdateSection}
        >
          <ArrowUpCircle size={16} />
          <span className="kd-chrome-badge" aria-hidden="true">
            新
          </span>
        </button>
      ) : null}
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
        aria-label={queueCount > 0 ? `下载队列，${queueCount} 个进行中` : "下载队列"}
        aria-pressed={queueOpen}
        data-open={queueOpen || undefined}
        title={queueCount > 0 ? `下载队列（${queueCount} 进行中）` : "下载队列"}
        onClick={onQueue}
      >
        <Download size={16} />
        {queueCount > 0 && (
          <span className="kd-chrome-badge" aria-hidden="true">
            {queueCount > 99 ? "99+" : queueCount}
          </span>
        )}
      </button>
      {showAsideToggle && (
        <button
          type="button"
          className="kd-chrome-btn"
          aria-label={asideLabel}
          aria-pressed={asideState !== "closed"}
          data-open={asideState === "open" || undefined}
          data-locked={asideState === "locked" || undefined}
          title={asideLabel}
          onClick={onAsideToggle}
        >
          {asideState === "open" ? (
            <PanelRightClose size={16} />
          ) : asideState === "closed" ? (
            <PanelRightOpen size={16} />
          ) : (
            <LockKeyhole size={15} />
          )}
        </button>
      )}
    </div>
  );
}
