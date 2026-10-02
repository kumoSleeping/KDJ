import { useContext, type ReactNode } from "react";
import { PanelTopClose } from "lucide-react";
import { PanelReorderContext } from "./panelReorder";
import { PanelCollapseContext } from "./panelCollapse";
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
  const collapse = useContext(PanelCollapseContext);
  const reorder = useContext(PanelReorderContext);
  const classes = [
    "kd-panel",
    raised ? "kd-panel-raised" : "",
    dense ? "kd-panel-dense" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const hasHead = heading !== undefined || actions !== undefined || collapse !== null;
  return (
    // data-badged 让 CSS 给首行留出角标的纵向压占，见 design.css
    <section className={classes} data-badged={title !== undefined ? "true" : undefined}>
      {title !== undefined && <CornerBadge tone={tone}>{title}</CornerBadge>}
      {hasHead && (
        <div className="kd-panel-head">
          {reorder}
          <span className="kd-grow kd-truncate">{heading}</span>
          {(actions !== undefined || collapse) && <span className="kd-row">
            {actions}
            {collapse && <button type="button" className="kd-manager-panel-action"
              aria-label={`收起 ${collapse.label} 面板`} title={`收起 ${collapse.label} 面板`}
              onClick={collapse.collapse}>
              <PanelTopClose size={13} strokeWidth={2.25} aria-hidden="true" />
            </button>}
          </span>}
        </div>
      )}
      <PanelReorderContext.Provider value={null}><PanelCollapseContext.Provider value={null}>
          {padded ? <div className="kd-panel-body">{children}</div> : children}
      </PanelCollapseContext.Provider></PanelReorderContext.Provider>
    </section>
  );
}
