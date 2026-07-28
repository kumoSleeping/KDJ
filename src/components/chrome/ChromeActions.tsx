import {
  Download,
  FolderTree,
  Info,
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";

export interface ChromeActionsProps {
  /** 单栏布局才显示：宽屏左栏已经是文件夹树。 */
  showFolders?: boolean;
  foldersOpen?: boolean;
  onFolders?(): void;
  detailOpen: boolean;
  detailAvailable: boolean;
  onDetail(): void;
  djOpen: boolean;
  onDj(): void;
  loginOpen: boolean;
  onLogin(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
  /** 无论右栏开关，都固定在本组最右侧。 */
  asideOpen: boolean;
  onAsideToggle(): void;
}

/**
 * 顶栏右侧入口：登录与下载队列各一颗，职责不再挂在平台图标上。
 */
export function ChromeActions({
  showFolders = false,
  foldersOpen = false,
  onFolders,
  detailOpen,
  detailAvailable,
  onDetail,
  djOpen,
  onDj,
  loginOpen,
  onLogin,
  queueOpen,
  queueCount,
  onQueue,
  asideOpen,
  onAsideToggle,
}: ChromeActionsProps) {
  return (
    <div className="kd-chrome-actions" role="group" aria-label="顶栏工具">
      {showFolders && onFolders && (
        <button
          type="button"
          className="kd-chrome-btn"
          aria-label="文件夹"
          aria-pressed={foldersOpen}
          data-open={foldersOpen || undefined}
          title="文件夹与曲库导航"
          onClick={onFolders}
        >
          <FolderTree size={16} />
        </button>
      )}
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label="曲目详情"
        aria-pressed={detailOpen}
        data-open={detailOpen || undefined}
        disabled={!detailAvailable}
        title={detailAvailable ? "打开当前选中曲目的详细信息" : "先在曲库中选一首歌"}
        onClick={onDetail}
      >
        <Info size={16} />
      </button>
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label="接播设置"
        aria-pressed={djOpen}
        data-open={djOpen || undefined}
        title="接播设置"
        onClick={onDj}
      >
        <SlidersHorizontal size={16} />
      </button>
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label="账号登录"
        aria-pressed={loginOpen}
        data-open={loginOpen || undefined}
        title="账号登录"
        onClick={onLogin}
      >
        <UserRound size={16} />
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
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label={asideOpen ? "关闭右侧栏" : "打开右侧栏"}
        aria-pressed={asideOpen}
        data-open={asideOpen || undefined}
        title={asideOpen ? "关闭右侧栏" : "打开右侧栏"}
        onClick={onAsideToggle}
      >
        {asideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </div>
  );
}
