export interface AsideHeadProps {
  title: string;
}

/**
 * 右栏眉目：可拖窗口 + 当前面板标题。
 * 开关固定在分析工作条右端，不随右栏出现/消失而换位置。
 */
export function AsideHead({ title }: AsideHeadProps) {
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
      {title ? <span className="kd-aside-head-title">{title}</span> : null}
      <span className="kd-aside-head-drag" data-tauri-drag-region aria-hidden="true" />
    </div>
  );
}
