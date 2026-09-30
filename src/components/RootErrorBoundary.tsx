import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { captureDiagnostic } from "../lib/diagnostics";
const DiagnosticActions = lazy(() => import("./settings/ActivityLogPanel").then(module => ({ default: module.ActivityLogPanel })));

/** 挡住未捕获渲染错误，避免整页白屏到无法自救。 */
export class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureDiagnostic("render", "react.boundary", error, info.componentStack || "");
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap" }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>界面崩溃</div>
          <div>{this.state.error.message}</div>
          <Suspense fallback={null}><DiagnosticActions /></Suspense>
          <button type="button" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
