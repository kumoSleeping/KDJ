import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import "./EditorDock.css";

/** Temporarily owns the right sidebar without changing the panel underneath. */
export function EditorDock({ title, tools, leading, children, onClose }: {
  title: string; tools?: ReactNode; leading?: ReactNode; children: ReactNode; onClose(): void;
}) {
  return <section className="kd-editor-dock" aria-label={title}>
    <header className="kd-editor-dock-head">
      <button type="button" aria-label="返回原面板" title="返回原面板" onClick={onClose}>
        <ArrowLeft size={16} /><span>返回</span>
      </button>
      {leading}<strong>{title}</strong>
      <div className="kd-editor-dock-tools">{tools}</div>
    </header>
    <div className="kd-editor-dock-body">{children}</div>
  </section>;
}
