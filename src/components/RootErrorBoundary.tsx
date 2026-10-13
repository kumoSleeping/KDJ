import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { captureDiagnostic } from "../lib/diagnostics";
import "./RootErrorBoundary.css";
const ErrorReport = lazy(() => import("./settings/ErrorReport").then(module => ({ default: module.ErrorReport })));

/** 挡住未捕获渲染错误，避免整页白屏到无法自救：说一句、可以上报、可以重新加载。 */
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
    if (!this.state.error) return this.props.children;
    return (
      <div className="kd-crash" role="alert">
        <div className="kd-crash-body">
          <h1 className="kd-crash-title">界面出了点问题</h1>
          <p className="kd-crash-message">{this.state.error.message}</p>
          <Suspense fallback={null}><ErrorReport /></Suspense>
          <button type="button" className="kd-crash-reload" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}
