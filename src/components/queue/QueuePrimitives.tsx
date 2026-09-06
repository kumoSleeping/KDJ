import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AlertTriangle, Ban, Check, ChevronDown, Clock3, Loader2, Pause, Play, Trash2, Video } from "lucide-react";
import { Button } from "../common";
import { CoverImage, VinylPlaceholder } from "../common/VinylPlaceholder";

/** Shared queue geometry deliberately retains the established download design tokens. */
export function QueueFrame({ className = "", style, ...props }: ComponentProps<"div">) {
  return <div {...props} className={`kd-col ${className}`} style={{ height: "100%", minHeight: 0, ...style }} />;
}
export function QueueList({ children }: { children: ReactNode }) {
  return <div className="kd-scroll kd-grow kd-download-task-list" style={{ minHeight: 0 }}>{children}</div>;
}
export interface QueueFact { count: number; label: string; tone: string }
export function QueueOverview({ facts, total, canStart, canSecondary, secondaryLabel, secondaryKind,
  startTitle, secondaryTitle, onStart, onSecondary }: {
  facts: QueueFact[]; total: number; canStart: boolean; canSecondary: boolean;
  secondaryLabel: string; secondaryKind: "pause" | "cancel" | "clear";
  startTitle?: string; secondaryTitle?: string; onStart(): void; onSecondary(): void;
}) {
  return <div className="kd-download-overview">
    <div className="kd-download-summary" title={`队列共 ${total} 项`} aria-live="polite">
      {facts.map((fact) => <span key={fact.label} className="kd-download-summary-fact" data-tone={fact.tone}>
        <strong>{fact.count}</strong><span>{fact.label}</span>
      </span>)}
    </div>
    <div className="kd-download-overview-actions">
      <Button variant="primary" size="sm" disabled={!canStart} title={startTitle} onClick={onStart}><Play size={11} />开始</Button>
      <Button variant="ghost" size="sm" disabled={!canSecondary} title={secondaryTitle} onClick={onSecondary}>
        {secondaryKind === "pause" ? <Pause size={11} /> : secondaryKind === "cancel" ? <Ban size={11} /> : <Trash2 size={11} />}{secondaryLabel}
      </Button>
    </div>
  </div>;
}
export function QueueStateMark({ state }: { state: string }) {
  const props = { size: 12, strokeWidth: 2.1, "aria-hidden": true as const };
  if (state === "running" || state === "processing") return <Loader2 className="kd-download-task-spinner" {...props} />;
  if (state === "done") return <Check {...props} />;
  if (state === "paused") return <Pause {...props} />;
  if (state === "failed") return <AlertTriangle {...props} />;
  if (state === "canceled") return <Ban {...props} />;
  return <Clock3 {...props} />;
}
export function QueueCover({ artwork, video = false }: { artwork: string; video?: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !artwork) { setVisible(false); return; }
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { root: host.closest(".kd-download-task-list") });
    observer.observe(host); return () => observer.disconnect();
  }, [artwork]);
  const fallback = video ? <span className="kd-download-task-cover-fallback"><Video size={18} /></span> : <VinylPlaceholder />;
  return <span ref={hostRef} className="kd-download-task-cover" aria-hidden="true">
    {visible && artwork ? <CoverImage src={artwork} className="kd-download-task-cover-image" loading="lazy" draggable={false} referrerPolicy="no-referrer" fallback={fallback} /> : fallback}
  </span>;
}
export function QueueChoice({ value, options, icon, label, disabled, onChange }: {
  value: string; options: ReadonlyArray<{ value: string; label: string }>;
  icon?: ReactNode; label: string; disabled?: boolean; onChange(value: string): void;
}) {
  return <label className="kd-download-task-quality kd-download-task-quality-control kd-mono" title={label}>
    {icon}<select value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.currentTarget.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select><ChevronDown size={9} aria-hidden="true" />
  </label>;
}
