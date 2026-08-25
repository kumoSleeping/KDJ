import {
  Columns3,
  Disc3,
  Download,
  LockKeyhole,
  LockKeyholeOpen,
  Library,
  PanelRight,
  ScanSearch,
  Settings,
  Upload,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useUpdateStore } from "../../stores/updateStore";
import type { WorkMode } from "../../lib/workMode";

export type AsideToggleState = "open" | "closed" | "locked";

export interface ChromeActionsProps {
  asideState?: AsideToggleState;
  onAsideLock?(): void;
  workMode: WorkMode;
  onWorkModeChange(mode: WorkMode): void;
  /** 主栏顶部的跨平台聚合搜索框是否展开。 */
  aggregateSearchOpen: boolean;
  onAggregateSearchChange(open: boolean): void;
  multiPaneEnabled: boolean;
  onMultiPane(): void;
  settingsOpen: boolean;
  onSettings(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
  /** 打开设置并定位到软件更新区；默认走 updateStore。 */
  onOpenUpdate?(): void;
}

/** 主栏顶部右侧的右栏锁、板块模式、设置和下载入口。 */
export function ChromeActions({
  asideState,
  onAsideLock,
  workMode,
  onWorkModeChange,
  aggregateSearchOpen,
  onAggregateSearchChange,
  multiPaneEnabled,
  onMultiPane,
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
  const showWorkModeSwitch = useAppStore(
    (state) => state.settings?.experimental_dj_mode ?? false,
  );

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
      <button
        type="button"
        className="kd-chrome-btn"
        data-action="aggregate-search"
        data-active={aggregateSearchOpen ? "true" : undefined}
        aria-pressed={aggregateSearchOpen}
        aria-label={aggregateSearchOpen ? "收起聚合搜索" : "展开聚合搜索"}
        title={aggregateSearchOpen ? "收起顶部聚合搜索" : "展开顶部聚合搜索"}
        onClick={() => onAggregateSearchChange(!aggregateSearchOpen)}
      >
        <ScanSearch size={17} />
      </button>
      {asideState && onAsideLock ? (
        <button
          type="button"
          className="kd-chrome-btn"
          data-action="aside-lock"
          data-locked={asideState === "locked" ? "true" : undefined}
          aria-pressed={asideState === "locked"}
          aria-label={asideState === "locked" ? "解除右侧栏锁定" : "锁定并收起右侧栏"}
          title={
            asideState === "locked"
              ? "右侧详情栏已锁定：点击解锁"
              : "锁定右侧详情栏，阻止曲目和视频自动弹出"
          }
          onClick={onAsideLock}
        >
          <span className="kd-aside-lock-glyph" aria-hidden="true">
            <PanelRight size={16} strokeWidth={2} />
            {asideState === "locked" ? (
              <LockKeyhole className="kd-aside-lock-mark" size={9} strokeWidth={2.8} />
            ) : (
              <LockKeyholeOpen className="kd-aside-lock-mark" size={9} strokeWidth={2.8} />
            )}
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
        data-action="workspace-panes"
        data-active={multiPaneEnabled ? "true" : undefined}
        aria-pressed={multiPaneEnabled}
        aria-label={multiPaneEnabled ? "关闭多板块模式" : "打开多板块模式"}
        title={
          multiPaneEnabled
            ? "多板块模式已开启：同时显示最多三个列表"
            : "多板块模式已关闭：只显示当前列表"
        }
        onClick={onMultiPane}
      >
        <Columns3 size={16} />
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
