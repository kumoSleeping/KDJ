import { cloneElement, isValidElement, useCallback, useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, Move, PanelTopClose } from "lucide-react";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { PanelReorderContext } from "./panelReorder";
import { PanelCollapseContext } from "./panelCollapse";
import { CornerBadge, type BadgeTone } from "./CornerBadge";
import { PanelMediaControlsContext } from "./panelMediaControls";
import { useThemePack } from "../../lib/themePack";
import { usePanelViewport } from "../../lib/panelViewport";
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
  /** Keep the caption and actions visible even inside a reorderable dock. */
  visibleHeader?: boolean;
  maximizable?: boolean;
  /** Stable identity for opening this mounted panel without enabling its dock slot. */
  expandKey?: string;
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
  maximizable = false,
  expandKey,
  padded = true,
  raised = false,
  dense = false,
  className,
  children,
}: PanelProps) {
  const collapse = useContext(PanelCollapseContext);
  const { portrait } = useLayoutSignals();
  const anchorRef = useRef<HTMLDivElement>(null);
  const maximizeButtonRef = useRef<HTMLButtonElement>(null);
  const [localMaximized, setLocalMaximized] = useState(false);
  const expandedPanelId = usePanelViewport(state => state.expandedPanelId);
  const setExpandedPanel = usePanelViewport(state => state.setExpandedPanel);
  const maximized = expandKey ? expandedPanelId === expandKey : localMaximized;
  const setMaximized = useCallback((value: boolean) => {
    if (expandKey) setExpandedPanel(value ? expandKey : null);
    else setLocalMaximized(value);
  }, [expandKey, setExpandedPanel]);
  const [maximizedBounds, setMaximizedBounds] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!maximized) return;
    const app = anchorRef.current?.closest(".kd-app");
    const stage = app?.querySelector<HTMLElement>(".kd-stage");
    const sidebar = anchorRef.current?.closest(".kd-table-wrap")?.querySelector<HTMLElement>(".kd-split-aside")
      ?? app?.querySelector<HTMLElement>(".kd-split-aside:not([hidden])");
    const measure = () => {
      // Landscape expansion covers only the right sidebar below aggregate search.
      // Portrait uses the stage between chrome and player bar.
      const bounds = stage?.getBoundingClientRect();
      if (!bounds) return;
      const rect = !portrait && sidebar && !sidebar.hidden ? sidebar.getBoundingClientRect() : bounds;
      const top = Math.max(bounds.top, rect.top);
      const bottom = Math.min(bounds.bottom, rect.bottom);
      const left = Math.max(bounds.left, rect.left);
      const right = Math.min(bounds.right, rect.right);
      setMaximizedBounds({ left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMaximized(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (sidebar) observer.observe(sidebar);
    if (stage) observer.observe(stage);
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", escape, true);
    };
  }, [maximized, portrait, setMaximized]);
  const previousMaximized = useRef(maximized);
  useLayoutEffect(() => {
    if (previousMaximized.current !== maximized) maximizeButtonRef.current?.focus({ preventScroll: true });
    previousMaximized.current = maximized;
  }, [maximized]);
  const reorder = useContext(PanelReorderContext);
  const themePack = useThemePack(state => state.active);
  const [mediaHost, setMediaHost] = useState<HTMLDivElement | null>(null);
  const headingId = useId();
  // Built-in light/dark use a small overlay drag button, not a title row or gutter.
  // Theme packs retain their captions; picture/video controls remain overlays.
  const minimal = Boolean(reorder || collapse) && !themePack
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
  const dragButton = minimal && reorder && !maximized && <div className="kd-panel-float-drag"
    data-over-media={headHost ? "true" : undefined}>
    {isValidElement<{ title?: string }>(reorder) ? cloneElement(reorder,
      { title: typeof heading === "string" ? `移动${heading}面板` : "移动面板" },
      <Move size={11} strokeWidth={1.75} aria-hidden="true" />) : reorder}
  </div>;
  const hasHead = maximizable || heading !== undefined || actions !== undefined || collapse !== null || Boolean(reorder);
  const head = hasHead && <div className={floatingHead ? "kd-panel-float-tools" : "kd-panel-head"}
    data-over-media={headHost ? "true" : undefined} data-inline={inlineHeadHost ? "true" : undefined}>
    {!minimal && !maximized && reorder}
    <span id={headingId} className="kd-panel-head-label kd-grow kd-truncate">{heading}</span>
    {(actions !== undefined || (collapse && !maximized && !portrait) || maximizable) && <span className="kd-row">
      {actions}
      {maximizable && <button ref={maximizeButtonRef} type="button" className="kd-manager-panel-action kd-panel-size-action"
        aria-label={maximized ? "还原面板" : "展开面板"} title={maximized ? "还原面板 · Esc" : "展开面板"}
        aria-pressed={maximized} onClick={() => setMaximized(!maximized)}>
        {maximized ? <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" />
          : <Maximize2 size={14} strokeWidth={1.75} aria-hidden="true" />}
      </button>}
      {collapse && !maximized && !portrait && <button type="button" className="kd-manager-panel-action"
        aria-label={`收起 ${collapse.label} 面板`} title={`收起 ${collapse.label} 面板`}
        onClick={() => { setMaximized(false); collapse.collapse(); }}>
        <PanelTopClose size={13} strokeWidth={2.25} aria-hidden="true" />
      </button>}
    </span>}
  </div>;
  const content = (
    // data-badged 让 CSS 给首行留出角标的纵向压占，见 design.css
    <section className={classes} data-badged={title !== undefined ? "true" : undefined}
      data-maximized={maximized ? "true" : undefined} style={maximized ? maximizedBounds : undefined}
      aria-labelledby={heading !== undefined ? headingId : undefined}>
      {title !== undefined && <CornerBadge tone={tone}>{title}</CornerBadge>}
      {inlineHeadHost ? <>{dragButton}{createPortal(head, inlineHeadHost)}</>
        : headHost ? createPortal(<>{dragButton}{head}</>, headHost) : <>{dragButton}{head}</>}
      <PanelMediaControlsContext.Provider value={floatingHead ? setMediaHost : null}>
        <PanelReorderContext.Provider value={null}><PanelCollapseContext.Provider value={null}>
          {padded ? <div className="kd-panel-body">{children}</div> : children}
        </PanelCollapseContext.Provider></PanelReorderContext.Provider>
      </PanelMediaControlsContext.Provider>
    </section>
  );
  // React owns both locations, including delegated events and unmount cleanup.
  return <>{maximizable && <div ref={anchorRef} hidden />}
    {maximized ? createPortal(content, anchorRef.current?.closest(".kd-app") ?? document.body) : content}
  </>;
}
