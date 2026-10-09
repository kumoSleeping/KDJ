import { useContext, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelTopClose } from "lucide-react";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { PanelCollapseContext, PanelDockedContext } from "./panelCollapse";
import { CornerBadge, type BadgeTone } from "./CornerBadge";
import { PanelMediaControlsContext } from "./panelMediaControls";
import { useThemePack } from "../../lib/themePack";
import "./Panel.css";

export interface PanelProps {
  /** 角标文案（会自动大写）。不传就没有角标。 */
  title?: ReactNode;
  tone?: BadgeTone;
  /** 主题标题栏名称；默认极简样式保留无障碍名称，不占标题行。 */
  heading?: ReactNode;
  actions?: ReactNode;
  /** In minimal mode, place actions in an existing content toolbar instead of a title row. */
  actionsHost?: HTMLElement | null;
  /** 不占用标题栏高度；名称保留给无障碍访问，操作悬浮显示，适用于所有主题。 */
  floatingHeader?: boolean;
  /** Keep the caption and actions visible even inside a stack. */
  visibleHeader?: boolean;
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
  actionsHost,
  floatingHeader = false,
  visibleHeader = false,
  padded = true,
  raised = false,
  dense = false,
  className,
  children,
}: PanelProps) {
  const collapse = useContext(PanelCollapseContext);
  const docked = useContext(PanelDockedContext);
  const { portrait } = useLayoutSignals();
  const themePack = useThemePack(state => state.active);
  const [mediaHost, setMediaHost] = useState<HTMLDivElement | null>(null);
  const headingId = useId();
  // Built-in light/dark stacks have no title row or gutter. Theme packs retain
  // their captions; picture/video controls remain overlays.
  const minimal = (docked || collapse !== null) && !themePack
    && !document.documentElement.hasAttribute("data-theme-pack");
  const floatingHead = floatingHeader || (minimal && !visibleHeader);
  const headHost = floatingHead ? mediaHost : null;
  const inlineHeadHost = floatingHead ? actionsHost : null;
  const classes = [
    "kd-panel",
    raised ? "kd-panel-raised" : "",
    dense ? "kd-panel-dense" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const hasHead = heading !== undefined || actions !== undefined || collapse !== null;
  const head = hasHead && <div className={floatingHead ? "kd-panel-float-tools" : "kd-panel-head"}
    data-over-media={headHost ? "true" : undefined} data-inline={inlineHeadHost ? "true" : undefined}>
    <span id={headingId} className="kd-panel-head-label kd-grow kd-truncate">{heading}</span>
    {(actions !== undefined || (collapse && !portrait)) && <span className="kd-row">
      {actions}
      {collapse && !portrait && <button type="button" className="kd-manager-panel-action"
        aria-label={`收起 ${collapse.label} 面板`} title={`收起 ${collapse.label} 面板`}
        onClick={collapse.collapse}>
        <PanelTopClose size={13} strokeWidth={2.25} aria-hidden="true" />
      </button>}
    </span>}
  </div>;
  return (
    // data-badged 让 CSS 给首行留出角标的纵向压占，见 design.css
    <section className={classes} data-badged={title !== undefined ? "true" : undefined}
      aria-labelledby={heading !== undefined ? headingId : undefined}>
      {title !== undefined && <CornerBadge tone={tone}>{title}</CornerBadge>}
      {inlineHeadHost ? createPortal(head, inlineHeadHost)
        : headHost ? createPortal(head, headHost) : head}
      <PanelMediaControlsContext.Provider value={floatingHead ? setMediaHost : null}>
        <PanelDockedContext.Provider value={false}><PanelCollapseContext.Provider value={null}>
          {padded ? <div className="kd-panel-body">{children}</div> : children}
        </PanelCollapseContext.Provider></PanelDockedContext.Provider>
      </PanelMediaControlsContext.Provider>
    </section>
  );
}
