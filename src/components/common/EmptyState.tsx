import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** 图标节点（lucide 组件实例），可选。 */
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  /** 底部动作区，一般放一个 Button。 */
  action?: ReactNode;
  className?: string;
}

/** 空列表 / 未连接 / 出错的统一占位。.kd-empty 自带 flex:1，会撑满父级剩余空间。 */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  const classes = ["kd-empty", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {icon}
      <div className="kd-empty-title">{title}</div>
      {hint !== undefined && <p className="kd-empty-hint">{hint}</p>}
      {action}
    </div>
  );
}
