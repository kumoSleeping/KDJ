import { useEffect, useMemo, useState } from "react";
import {
  Expand,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Usb,
} from "lucide-react";
import { formatBytes } from "../../lib/format";
import {
  VIRTUAL_DISK_SIZE_OPTIONS,
  virtualDiskGrowthOptions,
} from "../../lib/virtualDisk";
import { usePlaylistStore } from "../../stores/playlistStore";
import { Button, InlineNotice, Panel, PanelStack } from "../common";

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="kd-stream-cache-row">
      <span className="kd-muted">{label}</span>
      <span title={title ?? value}>{value}</span>
    </div>
  );
}

export function VirtualDiskPanel() {
  const status = usePlaylistStore((state) => state.virtualDisk);
  const operation = usePlaylistStore((state) => state.operation);
  const exporting = usePlaylistStore((state) => state.exporting);
  const error = usePlaylistStore((state) => state.deviceError);
  const refresh = usePlaylistStore((state) => state.refreshDevices);
  const mount = usePlaylistStore((state) => state.mountVirtualDisk);
  const grow = usePlaylistStore((state) => state.growVirtualDisk);
  const eject = usePlaylistStore((state) => state.ejectVirtualDisk);
  const deleteDisk = usePlaylistStore((state) => state.deleteVirtualDisk);
  const authorizeDevice = usePlaylistStore((state) => state.authorizeDevice);
  const clearError = usePlaylistStore((state) => state.clearError);
  const [sizeGib, setSizeGib] = useState(8);
  const [growSizeGib, setGrowSizeGib] = useState(16);
  const [confirming, setConfirming] = useState<"grow" | "delete" | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizedName, setAuthorizedName] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const growOptions = useMemo(
    () => virtualDiskGrowthOptions(status?.totalBytes ?? 0),
    [status?.totalBytes],
  );
  useEffect(() => {
    if (growOptions.length > 0 && !growOptions.some((size) => size === growSizeGib)) {
      setGrowSizeGib(growOptions[0]);
    }
  }, [growOptions, growSizeGib]);
  useEffect(() => {
    setConfirming(null);
  }, [status?.exists, status?.mounted, operation]);

  const busy = operation !== null || exporting !== null;
  const usedBytes = status?.mounted
    ? Math.max(0, status.totalBytes - status.availableBytes)
    : 0;
  const actionLabel = operation === "mount"
    ? status?.exists ? "正在加载" : "正在创建"
    : operation === "eject"
      ? "正在安全卸载"
      : operation === "grow"
        ? "正在建立更大镜像、迁移并验证数据"
        : operation === "delete"
          ? "正在安全卸载并彻底删除"
          : "";

  if (status && !status.supported) {
    return <div className="kd-scroll kd-djp"><Panel dense>当前系统不支持 KDJ 虚拟磁盘。</Panel></div>;
  }

  return (
    <div className="kd-scroll kd-djp kd-onelibrary-storage-overview">
      <PanelStack storageKey="kd-onelibrary-storage-panels">
        <Panel key="overview" heading="OneLibrary" dense>
          <div className="kd-virtual-disk-intro">
            <HardDrive size={18} aria-hidden="true" />
            <p>
              OneLibrary 让 KDJ 与兼容的 DJ 软件共享播放列表、曲目、封面和分析数据。
              KDJ 虚拟盘是在本机保存并由系统挂载的 ExFAT 磁盘镜像，不是云盘。
            </p>
          </div>
        </Panel>

        <Panel
          key="devices"
          heading="外置存储"
          dense
          actions={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="刷新设备状态"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={12} />
            </Button>
          }
        >
          <Button
            variant="ghost"
            disabled={authorizing || busy}
            onClick={() => {
              setAuthorizing(true);
              setAuthorizedName("");
              void authorizeDevice()
                .then((device) => device && setAuthorizedName(device.name))
                .catch(() => undefined)
                .finally(() => setAuthorizing(false));
            }}
          >
            {authorizing ? <LoaderCircle className="kd-spin" size={13} /> : <Usb size={13} />}
            选择未自动识别的存储
          </Button>
          {authorizedName ? <p className="kd-djp-note">已加入 {authorizedName}</p> : null}
        </Panel>

        <Panel key="virtual" heading="KDJ 虚拟盘" dense>
          {status?.exists ? (
            <div className="kd-djp-switch-list">
              <Fact label="状态" value={status.mounted ? "已加载" : "已卸载"} />
              <Fact label="镜像位置" value={status.imagePath} title={status.imagePath} />
              {status.mounted ? (
                <>
                  <Fact label="挂载点" value={status.mountPath} title={status.mountPath} />
                  <Fact label="容量" value={formatBytes(status.totalBytes)} />
                  <Fact label="已用" value={formatBytes(usedBytes)} />
                  <Fact label="可用" value={formatBytes(status.availableBytes)} />
                  <Fact label="文件系统" value={status.fileSystem || "ExFAT"} />
                  <Fact label="分区" value={status.partitionScheme || "MBR"} />
                  <Fact
                    label="镜像格式"
                    value={status.imageFormat || (window.kdj.platform === "darwin" ? "UDRW" : "VHD")}
                  />
                  <Fact label="协议" value={status.protocol} />
                </>
              ) : status.totalBytes > 0 ? (
                <Fact label="配置容量" value={formatBytes(status.totalBytes)} />
              ) : null}
            </div>
          ) : (
            <>
              <p className="kd-djp-note">创建后会作为名为 KDJ 的 ExFAT 卷供兼容软件读取。</p>
              <span className="kd-djp-label">容量</span>
              <div className="kd-djp-choice" role="radiogroup" aria-label="KDJ 虚拟磁盘容量">
                {VIRTUAL_DISK_SIZE_OPTIONS.map((size) => (
                  <button
                    key={size}
                    type="button"
                    role="radio"
                    className="kd-djp-choice-btn"
                    aria-checked={sizeGib === size}
                    disabled={busy}
                    onClick={() => setSizeGib(size)}
                  >
                    {size} GB
                  </button>
                ))}
              </div>
            </>
          )}

          {actionLabel ? (
            <p className="kd-djp-note"><LoaderCircle className="kd-spin" size={12} /> {actionLabel}</p>
          ) : null}

          <div className="kd-row kd-virtual-disk-actions">
            {!status?.mounted ? (
              <Button
                variant="primary"
                disabled={busy || !status}
                onClick={() => {
                  clearError();
                  void mount(sizeGib).catch(() => undefined);
                }}
              >
                {status?.exists ? <Power size={13} /> : <Plus size={13} />}
                {status?.exists ? "加载 KDJ" : "创建并加载"}
              </Button>
            ) : (
              <>
                <Button disabled={busy} onClick={() => void window.kdj.openPath(status.mountPath)}>
                  <FolderOpen size={13} />
                  {window.kdj.platform === "win32" ? "在资源管理器中打开" : "在 Finder 中打开"}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    clearError();
                    void eject().catch(() => undefined);
                  }}
                >
                  <PowerOff size={13} /> 安全卸载
                </Button>
              </>
            )}
          </div>

          {status?.mounted && growOptions.length > 0 ? (
            <div className="kd-virtual-disk-section">
              <span className="kd-djp-label">扩容目标</span>
              <div className="kd-djp-choice" role="radiogroup" aria-label="KDJ 虚拟盘扩容目标">
                {growOptions.map((size) => (
                  <button
                    key={size}
                    type="button"
                    role="radio"
                    className="kd-djp-choice-btn"
                    aria-checked={growSizeGib === size}
                    disabled={busy || confirming !== null}
                    onClick={() => setGrowSizeGib(size)}
                  >
                    {size} GB
                  </button>
                ))}
              </div>
              {confirming === "grow" ? (
                <div className="kd-virtual-disk-confirm" role="alert">
                  <ShieldCheck size={15} aria-hidden="true" />
                  <p>
                    将建立 {growSizeGib} GB 新镜像，完整复制并验证数据后再切换。
                    过程中需要同时容纳新旧镜像；失败会保留原盘。
                  </p>
                  <div className="kd-row">
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        clearError();
                        void grow(growSizeGib).catch(() => undefined);
                      }}
                    >
                      确认扩容至 {growSizeGib} GB
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button disabled={busy} onClick={() => setConfirming("grow")}>
                  <Expand size={13} /> 扩容至 {growSizeGib} GB
                </Button>
              )}
            </div>
          ) : null}

          {status?.exists ? (
            <div className="kd-virtual-disk-section" data-danger="true">
              <span className="kd-djp-label">危险操作</span>
              {confirming === "delete" ? (
                <div className="kd-virtual-disk-confirm" data-danger="true" role="alert">
                  <Trash2 size={15} aria-hidden="true" />
                  <p>
                    将先安全卸载，再永久删除容量为 {formatBytes(status.totalBytes)} 的
                    KDJ 镜像及其全部内容。此操作无法撤销。
                  </p>
                  <div className="kd-row">
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        clearError();
                        void deleteDisk().catch(() => undefined);
                      }}
                    >
                      确认彻底删除
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="danger" disabled={busy} onClick={() => setConfirming("delete")}>
                  <Trash2 size={13} /> 彻底删除 KDJ 虚拟盘…
                </Button>
              )}
            </div>
          ) : null}

          {status?.requiresElevation ? (
            <p className="kd-djp-note">
              Windows 创建、加载、扩容、卸载或删除时可能要求系统 UAC 权限。
            </p>
          ) : null}
          <InlineNotice text={error} onDismiss={clearError} block />
        </Panel>
      </PanelStack>
    </div>
  );
}
