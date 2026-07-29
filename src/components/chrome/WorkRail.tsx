import type { ReactNode } from "react";

/**
 * 板块自有工作条：左侧小图标与说明，右侧可挂搜索/动作。
 * 空闲时也占位（统计信息）；忙时（多选 / 任务）只换内容，不跳布局。
 */
export function WorkRail({
  idle = false,
  glyphs,
  texts,
  trailing,
  actions,
  label,
}: {
  idle?: boolean;
  glyphs: ReactNode[];
  texts: ReactNode[];
  /** 贴右的附属控件（如曲库内搜），在全局入口左侧。 */
  trailing?: ReactNode;
  /** 本栏的全局入口，贴在右端，和搜索平台键上下对齐。 */
  actions?: ReactNode;
  label: string;
}) {
  return (
    <div
      className="kd-activity"
      data-idle={idle ? "true" : undefined}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {glyphs.length > 0 ? <div className="kd-activity-glyphs">{glyphs}</div> : null}
      {texts.length > 0 ? <div className="kd-activity-texts">{texts}</div> : null}
      {trailing}
      {actions && <div className="kd-activity-actions">{actions}</div>}
    </div>
  );
}

export function WorkRailSelection({
  count,
  onSelectAll,
  onClear,
  onDone,
  actions,
}: {
  count: number;
  onSelectAll(): void;
  onClear(): void;
  onDone(): void;
  actions?: ReactNode;
}) {
  return (
    <span className="kd-activity-selection">
      <strong>已选 {count}</strong>
      <button type="button" onClick={onSelectAll}>
        全选
      </button>
      <button type="button" disabled={count === 0} onClick={onClear}>
        清除
      </button>
      {actions}
      <button type="button" onClick={onDone}>
        完成
      </button>
    </span>
  );
}
