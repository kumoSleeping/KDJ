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
  defaultVirtualDiskChangeSizeGib,
  normalizeVirtualDiskName,
  parseVirtualDiskSizeGib,
  VIRTUAL_DISK_DEFAULT_NAME,
  VIRTUAL_DISK_MAX_SIZE_GIB,
  VIRTUAL_DISK_MIN_SIZE_GIB,
  VIRTUAL_DISK_NAME_MAX_LENGTH,
  VIRTUAL_DISK_RESERVE_BYTES,
  VIRTUAL_DISK_SIZE_OPTIONS,
  virtualDiskChangeOptions,
  virtualDiskNameInputError,
  virtualDiskSizeGib,
  virtualDiskSizeInputError,
  virtualDiskSizeMib,
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

function CapacityPicker({
  value,
  options,
  disabled,
  error,
  label = "容量",
  onChange,
}: {
  value: string;
  options: readonly number[];
  disabled: boolean;
  error: string;
  label?: string;
  onChange: (value: string) => void;
}) {
  const parsed = parseVirtualDiskSizeGib(value);
  return (
    <>
      <span className="kd-djp-label">{label}</span>
      <div className="kd-djp-choice" role="group" aria-label={`KDJ 虚拟磁盘${label}`}>
        {options.map((size) => (
          <button
            key={size}
            type="button"
            className="kd-djp-choice-btn"
            aria-pressed={parsed === size}
            disabled={disabled}
            onClick={() => onChange(String(size))}
          >
            {size} GB
          </button>
        ))}
        <label className="kd-virtual-disk-custom-size">
          <span>自定义</span>
          <input
            className="kd-input"
            type="number"
            inputMode="decimal"
            min={VIRTUAL_DISK_MIN_SIZE_GIB}
            max={VIRTUAL_DISK_MAX_SIZE_GIB}
            step="0.1"
            value={value}
            disabled={disabled}
            aria-label={`自定义${label}`}
            aria-invalid={Boolean(error)}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => {
              const size = parseVirtualDiskSizeGib(value);
              if (size !== null) onChange(String(size));
            }}
          />
          <span>GB</span>
        </label>
      </div>
      {error ? (
        <p className="kd-virtual-disk-field-error" role="alert">{error}</p>
      ) : null}
    </>
  );
}

function VolumeNameField({
  id,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  error: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="kd-virtual-disk-name-field">
      <label className="kd-djp-label" htmlFor={id}>
        磁盘名称
      </label>
      <input
        id={id}
        className="kd-input"
        value={value}
        maxLength={VIRTUAL_DISK_NAME_MAX_LENGTH}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p className="kd-virtual-disk-field-error" role="alert">{error}</p>
      ) : null}
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
  const [sizeInput, setSizeInput] = useState("8");
  const [volumeName, setVolumeName] = useState(VIRTUAL_DISK_DEFAULT_NAME);
  const [growSizeInput, setGrowSizeInput] = useState("16");
  const [growVolumeName, setGrowVolumeName] = useState(VIRTUAL_DISK_DEFAULT_NAME);
  const [confirming, setConfirming] = useState<"grow" | "delete" | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizedName, setAuthorizedName] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const configuredBytes = status ? status.configuredBytes || status.totalBytes : 0;
  const usedBytes = status?.mounted
    ? Math.max(0, status.totalBytes - status.availableBytes)
    : 0;
  const minimumChangeBytes = usedBytes + VIRTUAL_DISK_RESERVE_BYTES;
  const changeOptions = useMemo(
    () => virtualDiskChangeOptions(configuredBytes, minimumChangeBytes),
    [configuredBytes, minimumChangeBytes],
  );
  useEffect(() => {
    setGrowSizeInput(String(defaultVirtualDiskChangeSizeGib(configuredBytes, changeOptions)));
  }, [changeOptions, configuredBytes]);
  useEffect(() => {
    if (status?.exists && status.name) setGrowVolumeName(status.name);
  }, [status?.exists, status?.name]);
  useEffect(() => {
    setConfirming(null);
  }, [status?.exists, status?.mounted, operation]);

  const busy = operation !== null || exporting !== null;
  const sizeGib = parseVirtualDiskSizeGib(sizeInput);
  const sizeError = virtualDiskSizeInputError(sizeInput);
  const volumeNameError = virtualDiskNameInputError(volumeName);
  const growSizeGib = parseVirtualDiskSizeGib(growSizeInput);
  const growSizeError = virtualDiskSizeInputError(growSizeInput, minimumChangeBytes);
  const growVolumeNameError = virtualDiskNameInputError(growVolumeName);
  const currentSizeMib = virtualDiskSizeMib(virtualDiskSizeGib(configuredBytes));
  const targetSizeMib = growSizeGib === null ? null : virtualDiskSizeMib(growSizeGib);
  const hasDiskChange = targetSizeMib !== null
    && !growSizeError
    && !growVolumeNameError
    && (
      targetSizeMib !== currentSizeMib
      || normalizeVirtualDiskName(growVolumeName) !== status?.name
    );
  const actionLabel = operation === "mount"
    ? status?.exists ? "正在加载" : "正在创建"
    : operation === "eject"
      ? "正在安全卸载"
      : operation === "grow"
        ? "正在改变容量并迁移数据"
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
              OneLibrary 是一种 DJ 曲库格式，可让播放列表、Cue 点和 Beatgrid 等演出数据
              在兼容的软件与硬件间使用。KDJ 同时支持真实设备和虚拟设备。
              你可以连接 U 盘或移动硬盘，也可以创建 KDJ 虚拟盘。
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
              <Fact label="磁盘名称" value={status.name} />
              <Fact label="镜像位置" value={status.imagePath} title={status.imagePath} />
              {status.mounted ? (
                <>
                  <Fact label="挂载点" value={status.mountPath} title={status.mountPath} />
                  <Fact label="容量" value={formatBytes(configuredBytes)} />
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
              ) : configuredBytes > 0 ? (
                <Fact label="配置容量" value={formatBytes(configuredBytes)} />
              ) : null}
            </div>
          ) : (
            <>
              <VolumeNameField
                id="kd-virtual-disk-create-name"
                value={volumeName}
                disabled={busy}
                error={volumeNameError}
                onChange={setVolumeName}
              />
              <CapacityPicker
                value={sizeInput}
                options={VIRTUAL_DISK_SIZE_OPTIONS}
                disabled={busy}
                error={sizeError}
                onChange={setSizeInput}
              />
            </>
          )}

          {actionLabel ? (
            <p className="kd-djp-note"><LoaderCircle className="kd-spin" size={12} /> {actionLabel}</p>
          ) : null}

          <div className="kd-row kd-virtual-disk-actions">
            {!status?.mounted ? (
              <Button
                variant="primary"
                disabled={
                  busy
                  || !status
                  || (!status.exists
                    && (sizeGib === null || Boolean(sizeError || volumeNameError)))
                }
                onClick={() => {
                  clearError();
                  const task = status?.exists
                    ? mount()
                    : mount(sizeGib ?? undefined, normalizeVirtualDiskName(volumeName));
                  void task.catch(() => undefined);
                }}
              >
                {status?.exists ? <Power size={13} /> : <Plus size={13} />}
                {status?.exists ? `加载 ${status.name}` : "创建并加载"}
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

          {status?.mounted ? (
            <div className="kd-virtual-disk-section">
              <span className="kd-virtual-disk-section-title">改变容量</span>
              <VolumeNameField
                id="kd-virtual-disk-grow-name"
                value={growVolumeName}
                disabled={busy || confirming !== null}
                error={growVolumeNameError}
                onChange={setGrowVolumeName}
              />
              <CapacityPicker
                label="新容量"
                value={growSizeInput}
                options={changeOptions}
                disabled={busy || confirming !== null}
                error={growSizeError}
                onChange={setGrowSizeInput}
              />
              {confirming === "grow" ? (
                <div className="kd-virtual-disk-confirm" role="alert">
                  <ShieldCheck size={15} aria-hidden="true" />
                  <p>
                    将创建名为 {normalizeVirtualDiskName(growVolumeName)} 的 {growSizeGib} GB
                    新镜像并复制原盘数据。完成后换用新镜像；失败时保留原盘。
                  </p>
                  <div className="kd-row">
                    <Button
                      variant="primary"
                      disabled={
                        busy
                        || !hasDiskChange
                      }
                      onClick={() => {
                        setConfirming(null);
                        clearError();
                        if (growSizeGib === null) return;
                        void grow(growSizeGib, normalizeVirtualDiskName(growVolumeName))
                          .catch(() => undefined);
                      }}
                    >
                      确认改变容量
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  disabled={
                    busy
                    || !hasDiskChange
                  }
                  onClick={() => setConfirming("grow")}
                >
                  <Expand size={13} /> 改变容量
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
                    将先安全卸载，再永久删除容量为 {formatBytes(configuredBytes)} 的
                    {status.name} 镜像及其全部内容。此操作无法撤销。
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
              Windows 创建、加载、改变容量、卸载或删除时可能要求系统 UAC 权限。
            </p>
          ) : null}
          <InlineNotice text={error} onDismiss={clearError} block />
        </Panel>
      </PanelStack>
    </div>
  );
}
