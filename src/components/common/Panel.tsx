import type { ReactNode } from "react";
import { CornerBadge, type BadgeTone } from "./CornerBadge";

export interface PanelProps {
  /** 角标文案（会自动大写）。不传就没有角标。 */
  title?: ReactNode;
  tone?: BadgeTone;
  /** 面板内的小标题行；和 actions 任一存在就渲染 .kd-panel-head。 */
  heading?: ReactNode;
  actions?: ReactNode;
  /** 表格/列表类内容自己控制内边距时传 false。 */
  padded?: boolean;
  raised?: boolean;
  /** 紧凑模式：右侧详情栏、设置页这种"条目多"的地方用，省下大量纵向空间。 */
  dense?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Panel({
  title,
  tone = "theme",
  heading,
  actions,
  padded = true,
  raised = false,
  dense = false,
  className,
  children,
}: PanelProps) {
  const classes = [
    "kd-panel",
    raised ? "kd-panel-raised" : "",
    dense ? "kd-panel-dense" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const hasHead = heading !== undefined || actions !== undefined;
  return (
    // data-badged 让 CSS 给首行留出角标的纵向压占，见 design.css
    <section className={classes} data-badged={title !== undefined ? "true" : undefined}>
      {title !== undefined && <CornerBadge tone={tone}>{title}</CornerBadge>}
      {hasHead && (
        <div className="kd-panel-head">
          <span className="kd-grow kd-truncate">{heading}</span>
          {actions !== undefined && <span className="kd-row">{actions}</span>}
        </div>
      )}
      {padded ? <div className="kd-panel-body">{children}</div> : children}
    </section>
  );
}
