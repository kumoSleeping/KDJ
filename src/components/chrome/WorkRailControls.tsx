import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListCollapse, Pin, Search, X } from "lucide-react";
import { isOutsideFolder } from "../../lib/outsideFolder";

function LibrarySearchField({
  inputRef,
  value,
  folder,
  onChange,
  onClear,
  onBlurEmpty,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  value: string;
  folder: string;
  onChange(value: string): void;
  onClear(): void;
  onBlurEmpty?: () => void;
}) {
  return (
    <label className="kd-activity-search kd-activity-search-expanded">
      <Search size={13} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={
          folder && !isOutsideFolder(folder) ? "在当前文件夹中搜索" : "在全部歌曲中搜索"
        }
        aria-label={
          folder && !isOutsideFolder(folder)
            ? "搜索当前文件夹的曲目名称"
            : folder
              ? "搜索目录外曲目的名称"
              : "搜索全部曲目的名称"
        }
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClear();
          }
        }}
        onBlur={() => {
          if (!value.trim()) onBlurEmpty?.();
        }}
      />
      <button
        type="button"
        aria-label="关闭曲目搜索"
        title="关闭曲目搜索"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClear}
      >
        <X size={12} />
      </button>
    </label>
  );
}

/** Shared local search: a small icon that expands in the work rail. */
export function LibrarySearchTools({ value, folder, selecting = false, onChange, children }: {
  value: string;
  folder: string;
  selecting?: boolean;
  onChange(value: string): void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(() => Boolean(value.trim()));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selecting) setOpen(false);
    else if (value.trim()) setOpen(true);
  }, [selecting, value]);
  useEffect(() => {
    if (!selecting && open) inputRef.current?.focus();
  }, [selecting, open]);
  const expanded = !selecting && open;
  return <span className="kd-activity-trailing-tools" data-searching={expanded ? "true" : undefined}>
    {expanded ? <LibrarySearchField inputRef={inputRef} value={value} folder={folder}
      onChange={onChange} onClear={() => { onChange(""); setOpen(false); }}
      onBlurEmpty={() => setOpen(false)} /> : <button type="button"
        className="kd-activity-search-toggle" aria-label="搜索曲目"
        title={folder && !isOutsideFolder(folder) ? "在当前文件夹中搜索" : "在全部歌曲中搜索"}
        onClick={() => setOpen(true)}>
        <Search size={14} strokeWidth={2.25} />
      </button>}
    {children}
  </span>;
}

export function WorkRailPin({ pinned, onChange, label, title }: {
  pinned: boolean;
  onChange(pinned: boolean): void;
  label: string;
  title?: string;
}) {
  const action = `${pinned ? "取消固定" : "固定"}${label}`;
  return <button type="button" className="kd-activity-search-toggle" data-action="workspace-pin"
    data-pinned={pinned ? "true" : undefined} aria-pressed={pinned}
    aria-label={action} title={title ?? action} onClick={() => onChange(!pinned)}>
    <Pin size={14} strokeWidth={2.25} fill={pinned ? "currentColor" : "none"} />
  </button>;
}

export function WorkRailCollapse({ label, onClick }: { label: string; onClick(): void }) {
  return <button type="button" className="kd-chrome-btn" data-action="dismiss-results"
    aria-label={label} title={label} onClick={onClick}>
    <ListCollapse size={15} strokeWidth={2.15} />
  </button>;
}
