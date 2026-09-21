import { Download } from "lucide-react";

/** 保留序号占位，悬停或键盘聚焦时直接下载当前行。 */
export function ResultDownloadIndex({ rowNumber, title, onDownload, disabled = false }: {
  rowNumber: number;
  title: string;
  onDownload?: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="kd-result-download-index">
      <span className="kd-result-index">{rowNumber}</span>
      {onDownload && (
        <button
          type="button"
          className="kd-result-download-btn"
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
      )}
    </span>
  );
}
