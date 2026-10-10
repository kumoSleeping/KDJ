import type { ReactNode } from "react";
import { Download } from "lucide-react";

/**
 * The download key of a result row. It lies at the right-hand end of the row's first data
 * column (see `resultDownloadKeyColumn`), over the tail of that cell's text, and shows while the
 * row is pointed at or the key has keyboard focus. It is a bare icon: no plate, no outline. The
 * row's number stays a number.
 */
export function ResultDownloadKey({ title, onDownload, disabled = false }: {
  title: string;
  onDownload(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="kd-result-key"
      aria-label={`将 ${title} 加入下载队列`}
      title="加入下载队列"
      disabled={disabled}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail > 1) return;
        onDownload();
      }}
    >
      <Download size={14} aria-hidden="true" />
    </button>
  );
}

/**
 * What the first data cell holds, with the key at its right-hand end. The cell's own content
 * keeps its place and width; while the key shows, its tail is faded out under it by a mask
 * (ResultTable.css) instead of being pushed aside. The key comes first in the markup so that
 * its keyboard focus can reach the content after it; it is placed by position, not by order.
 */
export function withDownloadKey(content: ReactNode, key: ReactNode, bodyClassName?: string) {
  if (!key) return bodyClassName ? <span className={bodyClassName}>{content}</span> : content;
  return (
    <span className="kd-result-keyed">
      {key}
      <span className={bodyClassName ? `${bodyClassName} kd-result-keyed-body` : "kd-result-keyed-body"}>
        {content}
      </span>
    </span>
  );
}
