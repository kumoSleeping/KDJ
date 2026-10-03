import { useEffect, useState, type ReactNode } from "react";
import "./AsyncPanelBody.css";

export type PanelContentState = "loading" | "ready" | "empty";

/** Keep loading and resolved content in one rectangle without blocking the dock. */
export function AsyncPanelBody({ state, kind, children }: {
  state: PanelContentState;
  kind: "lyrics" | "visualizer";
  children?: ReactNode;
}) {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPainted(true));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);
  const visibleState = painted ? state : "loading";
  return <div className="kd-async-panel-body" data-state={visibleState} data-kind={kind} aria-busy={visibleState === "loading"}>
    <div className="kd-async-panel-clip">
      <div className="kd-async-panel-space">
        <div className="kd-async-panel-content" inert={visibleState !== "ready"} aria-hidden={visibleState !== "ready"}>
          {children}
        </div>
      </div>
    </div>
  </div>;
}
