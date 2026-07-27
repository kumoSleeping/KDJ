import type { ReactNode } from "react";

export interface SelectionBarProps {
  count: number;
  onSelectAll(): void;
  onClear(): void;
  onDone(): void;
  children?: ReactNode;
}

/** 曲库与搜索结果共用的批选工作条；清除与完成的语义由调用方统一提供。 */
export function SelectionBar({ count, onSelectAll, onClear, onDone, children }: SelectionBarProps) {
  return (
    <div className="kd-selection-bar">
      <strong>已选 {count} 首</strong>
      <button type="button" onClick={onSelectAll}>全选</button>
      <button type="button" disabled={count === 0} onClick={onClear}>清除</button>
      <span className="kd-toolbar-gap" />
      {children}
      <button type="button" onClick={onDone}>完成</button>
    </div>
  );
}
