import type { ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

export type TrackAsideFace = "detail" | "lyrics";

export interface AsideFaceSwitchProps {
  face: TrackAsideFace;
  onFaceChange(face: TrackAsideFace): void;
}

/** 详情 / 歌词双极分段，宽屏眉目与窄屏抽屉头共用。 */
export function AsideFaceSwitch({ face, onFaceChange }: AsideFaceSwitchProps) {
  return (
    <div
      className="kd-aside-face"
      role="tablist"
      aria-label="右栏内容"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="tab"
        aria-selected={face === "detail"}
        aria-pressed={face === "detail"}
        onClick={() => onFaceChange("detail")}
      >
        详情
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={face === "lyrics"}
        aria-pressed={face === "lyrics"}
        onClick={() => onFaceChange("lyrics")}
      >
        歌词
      </button>
    </div>
  );
}

export interface AsideToggleButtonProps {
  open: boolean;
  canOpen: boolean;
  onToggle(): void;
}

/** 右栏开合：保留统一命中尺寸，但用边栏语义样式与搜索关闭键区分。 */
export function AsideToggleButton({ open, canOpen, onToggle }: AsideToggleButtonProps) {
  const disabled = !open && !canOpen;
  return (
    <button
      type="button"
      className="kd-activity-search-toggle"
      data-action="toggle-aside"
      data-open={open ? "true" : undefined}
      aria-label={open ? "收起右侧栏" : "展开右侧栏"}
      title={open ? "收起右侧栏" : "展开右侧栏"}
      disabled={disabled}
      onClick={onToggle}
    >
      {open ? <PanelRightClose size={14} strokeWidth={2.25} /> : <PanelRightOpen size={14} strokeWidth={2.25} />}
    </button>
  );
}

export interface AsideHeadProps {
  title: string;
  /** 歌词模式下详情 / 歌词双极切换；有值时替代纯标题。 */
  face?: TrackAsideFace;
  onFaceChange?: (face: TrackAsideFace) => void;
  /** 宽屏右栏开合键：弹出时挂在右栏顶条最右端。 */
  asideToggle?: ReactNode;
  /** 当前面板自己的动作，例如下载队列固定、当前播放详情固定。 */
  tools?: ReactNode;
}

/**
 * 右栏眉目：可拖窗口 + 当前面板标题（或详情/歌词分段）。
 * 开合键弹出时在右栏顶条右端；收起时在曲库工作条搜索键右侧。
 */
export function AsideHead({ title, face, onFaceChange, asideToggle, tools }: AsideHeadProps) {
  const bipolar = Boolean(face && onFaceChange);

  return (
    <div
      className="kd-aside-head"
      data-tauri-drag-region
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
        window.kdj?.windowControl("drag");
      }}
    >
      {bipolar && face && onFaceChange ? (
        <AsideFaceSwitch face={face} onFaceChange={onFaceChange} />
      ) : title ? (
        <span className="kd-aside-head-title">{title}</span>
      ) : null}
      <span className="kd-aside-head-drag" data-tauri-drag-region aria-hidden="true" />
      {tools || asideToggle ? (
        <span className="kd-aside-head-tools">
          {tools}
          {asideToggle}
        </span>
      ) : null}
    </div>
  );
}
