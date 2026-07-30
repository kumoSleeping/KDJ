import { Component, type ErrorInfo, type ReactNode } from "react";

function reportFatal(message: string, stack?: string): void {
  console.error("[KDJ fatal]", message, stack || "");
}

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
    reportFatal(error.message, `${error.stack || ""}\n${info.componentStack || ""}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap" }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>界面崩溃</div>
          <div>{this.state.error.message}</div>
          <button type="button" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
