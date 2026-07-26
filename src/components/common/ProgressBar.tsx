export type ProgressState = "running" | "done" | "failed";

export interface ProgressBarProps {
  /** 0..1，超界自动夹取。 */
  value?: number;
  state?: ProgressState;
  /** 总量未知时（比如后端没给 total_bytes）走滚动条动画。 */
  indeterminate?: boolean;
  className?: string;
}

export function ProgressBar({
  value = 0,
  state = "running",
  indeterminate = false,
  className,
}: ProgressBarProps) {
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const classes = ["kd-progress", className ?? ""].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      data-state={state}
      data-indeterminate={indeterminate ? "true" : undefined}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
    >
      {/* 宽度是数据不是布局，只能内联 */}
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}
