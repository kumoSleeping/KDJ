import {
  Download,
  Settings,
  Upload,
} from "lucide-react";
import { useUpdateStore } from "../../stores/updateStore";

export type AsideToggleState = "open" | "closed" | "locked";

export interface ChromeActionsProps {
  settingsOpen: boolean;
  onSettings(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
}

/** 主栏顶部右侧的设置、下载入口。右栏收起按钮已移到右栏头部。 */
export function ChromeActions({
  settingsOpen,
  onSettings,
  queueOpen,
  queueCount,
  onQueue,
}: ChromeActionsProps) {
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const latest = useUpdateStore((s) => s.info?.latest ?? "");
  const openUpdateSection = useUpdateStore((s) => s.openUpdateSection);

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
          {/* 经典「上箭头 + 底框」升级形；灰色，有更新只靠角点提示。 */}
          <Upload size={16} />
          <span className="kd-chrome-dot" aria-hidden="true" />
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
    </div>
  );
}
