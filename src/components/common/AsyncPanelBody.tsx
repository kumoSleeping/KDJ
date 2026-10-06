import { useLayoutEffect, useRef, type ReactNode } from "react";
import "./AsyncPanelBody.css";

export type PanelContentState = "loading" | "ready" | "empty";

/** Keep loading and resolved content in one rectangle without blocking the dock. */
export function AsyncPanelBody({ state, kind, children }: {
  state: PanelContentState;
  kind: "lyrics" | "visualizer";
  children?: ReactNode;
}) {
  // Loading is not a new size: keep the last resolved footprint until we know
  // whether this song has content. Empty -> loading -> empty must not bounce.
  const settledExpanded = useRef(state !== "empty");
  const expanded = state === "loading" ? settledExpanded.current : state === "ready";
  useLayoutEffect(() => { if (state !== "loading") settledExpanded.current = expanded; }, [state, expanded]);
  return <div className="kd-async-panel-body" data-state={state} data-expanded={expanded} data-kind={kind} aria-busy={state === "loading"}>
    <div className="kd-async-panel-clip">
      <div className="kd-async-panel-space">
        <div className="kd-async-panel-content" inert={state !== "ready"} aria-hidden={state !== "ready"}>
          {children}
        </div>
      </div>
    </div>
  </div>;
}
