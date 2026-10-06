import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AlertTriangle, Ban, Check, Clock3, History, Loader2, Pause, Play, Trash2, Video } from "lucide-react";
import { Button } from "../common";
import { Select } from "../common/Select";
import { CoverImage, VinylPlaceholder } from "../common/VinylPlaceholder";

/** Shared queue geometry deliberately retains the established download design tokens. */
export function QueueFrame({ className = "", style, ...props }: ComponentProps<"div">) {
  return <div {...props} className={`kd-col ${className}`} style={{ height: "100%", minHeight: 0, ...style }} />;
}
export function QueueList({ children, className = "", style, ...props }: ComponentProps<"div">) {
  return <div {...props} className={`kd-scroll kd-grow kd-download-task-list ${className}`} style={{ minHeight: 0, ...style }}>{children}</div>;
}
export function QueueEntry({ order, title, titleTooltip = title, subtitle, state, status, stateTitle, missing,
  percent, cover, metadata, actions, children, className = "", ...props }: Omit<ComponentProps<"article">, "title"> & {
  order: string; title: string; titleTooltip?: string; subtitle?: string;
  state: string; status: string; stateTitle?: string; missing?: boolean;
  percent?: string; cover: ReactNode; metadata?: ReactNode; actions?: ReactNode;
}) {
  return <article {...props} className={`kd-download-task ${className}`} data-state={state} data-missing={missing || undefined}>
    <div className="kd-download-task-head">
      <span className="kd-download-task-order kd-mono" aria-label={`队列第 ${Number.parseInt(order, 10)} 项`}>{order}</span>
      <div className="kd-download-task-summary">
        {cover}
        <span className="kd-download-task-copy">
          <span className="kd-download-task-title" title={titleTooltip}>{title}</span>
          <span className="kd-download-task-byline">
            {subtitle && <span className="kd-download-task-artist kd-truncate" title={subtitle}>{subtitle}</span>}
            <span className="kd-download-task-state">
              <span className="kd-download-task-state-label">
                <QueueStateMark state={missing ? "failed" : state} />
                <span className="kd-download-task-state-text" title={stateTitle}>{status}</span>
              </span>
              {percent && <span className="kd-download-task-percent kd-mono">{percent}</span>}
            </span>
          </span>
          {metadata && <span className="kd-download-task-meta">{metadata}</span>}
        </span>
      </div>
      {actions && <div className="kd-download-task-actions">{actions}</div>}
    </div>
    {children}
  </article>;
}
export interface QueueFact { count: number; label: string; tone: string }
export function QueueOverview({ facts, total, canStart, canSecondary, secondaryLabel, secondaryKind,
  startTitle, secondaryTitle, onStart, onSecondary, extraActions }: {
  facts: QueueFact[]; total: number; canStart: boolean; canSecondary?: boolean;
  secondaryLabel?: string; secondaryKind?: "pause" | "cancel" | "clear" | "history";
  extraActions?: ReactNode;
  startTitle?: string; secondaryTitle?: string; onStart(): void; onSecondary?(): void;
}) {
  return <div className="kd-download-overview">
    <div className="kd-download-summary" title={`队列共 ${total} 项`} aria-live="polite">
      {facts.map((fact) => <span key={fact.label} className="kd-download-summary-fact" data-tone={fact.tone}>
        <strong>{fact.count}</strong><span>{fact.label}</span>
      </span>)}
    </div>
    <div className="kd-download-overview-actions">
      <Button variant="primary" size="sm" disabled={!canStart} title={startTitle} onClick={onStart}><Play size={11} />开始</Button>
      {onSecondary && <Button variant="ghost" size="sm" disabled={!canSecondary} title={secondaryTitle} onClick={onSecondary}>
        {secondaryKind === "pause" ? <Pause size={11} /> : secondaryKind === "cancel" ? <Ban size={11} /> : secondaryKind === "history" ? <History size={11} /> : <Trash2 size={11} />}{secondaryLabel}
      </Button>}
      {extraActions}
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
    {icon}<Select value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.currentTarget.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  </label>;
}
