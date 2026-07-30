import { PanelRightClose } from "lucide-react";

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

export interface AsideHeadProps {
  title: string;
  /** 歌词模式下详情 / 歌词双极切换；有值时替代纯标题。 */
  face?: TrackAsideFace;
  onFaceChange?: (face: TrackAsideFace) => void;
  /** 点击关闭按钮收起右栏；提供时渲染右上角关闭按钮。 */
  onClose?(): void;
}

/**
 * 右栏眉目：可拖窗口 + 当前面板标题（或详情/歌词分段）。
 * 开关固定在分析工作条右端，不随右栏出现/消失而换位置。
 */
export function AsideHead({ title, face, onFaceChange, onClose }: AsideHeadProps) {
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
      {onClose && (
        <button
          type="button"
          className="kd-aside-head-close"
          aria-label="收起右侧栏"
          title="收起右侧栏"
          onClick={onClose}
        >
          <PanelRightClose size={14} />
        </button>
      )}
    </div>
  );
}
