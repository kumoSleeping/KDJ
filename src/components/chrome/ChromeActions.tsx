import {
  Disc3,
  Download,
  Library,
  Settings,
  Upload,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useUpdateStore } from "../../stores/updateStore";
import type { WorkMode } from "../../lib/workMode";
const LABS_BUILD = typeof __KDJ_LABS__ !== "undefined" && __KDJ_LABS__;

export interface ChromeActionsProps {
  workMode: WorkMode;
  onWorkModeChange(mode: WorkMode): void;
  settingsOpen: boolean;
  onSettings(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
  /** 打开设置并定位到软件更新区；默认走 updateStore。 */
  onOpenUpdate?(): void;
}

/** 主栏顶部右侧的工作模式、设置和下载入口。 */
export function ChromeActions({
  workMode,
  onWorkModeChange,
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
  const configuredWorkModeSwitch = useAppStore(
    (state) => state.settings?.experimental_dj_mode ?? false,
  );
  const showWorkModeSwitch = LABS_BUILD && configuredWorkModeSwitch;

  return (
    <div className="kd-chrome-actions" role="group" aria-label="顶栏工具">
      {showWorkModeSwitch ? (
        <button
          type="button"
          className="kd-chrome-btn kd-work-mode-switch"
          data-mode={workMode}
          aria-label={workMode === "manager" ? "切换到 DJ 模式" : "切换到管理器模式"}
          title={workMode === "manager" ? "进入 DJ 模式" : "返回管理器模式"}
          onClick={() => onWorkModeChange(workMode === "manager" ? "dj" : "manager")}
        >
          <span className="kd-work-mode-glyph" aria-hidden="true">
            <Library className="kd-work-mode-manager" size={16} />
            <Disc3 className="kd-work-mode-dj" size={16} />
          </span>
        </button>
      ) : null}
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
        aria-label="设置"
        aria-pressed={settingsOpen}
        data-open={settingsOpen || undefined}
        title="设置"
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
