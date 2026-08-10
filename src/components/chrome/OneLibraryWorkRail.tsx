import type { ReactNode } from "react";
import { CheckSquare, HardDrive, ListMusic, LoaderCircle, PanelRightClose, Trash2, Usb } from "lucide-react";
import { usePlaylistStore } from "../../stores/playlistStore";
import { Button } from "../common";
import { WorkRail, WorkRailSelection } from "./WorkRail";

export function OneLibraryWorkRail({
  asideToggle,
  onCollapse,
}: {
  asideToggle?: ReactNode;
  onCollapse(): void;
}) {
  const target = usePlaylistStore((state) => state.selectedTarget);
  const tracks = usePlaylistStore((state) => state.selectedTracks);
  const selectedIds = usePlaylistStore((state) => state.selectedContentIds);
  const selectionMode = usePlaylistStore((state) => state.selectionMode);
  const exporting = usePlaylistStore((state) => state.exporting);
  const devices = usePlaylistStore((state) => state.devices);
  const removeTracks = usePlaylistStore((state) => state.removeTracks);
  if (!target) return null;

  const selecting = selectionMode || selectedIds.length > 1;
  const device = devices.find((candidate) => candidate.path === target.device_path);
  const writable = !device?.read_only;
  const busy = exporting === `${target.device_path}\u0000${target.playlist_id}`;
  const trailing = (
    <span className="kd-activity-trailing-tools">
      <button
        type="button"
        className="kd-activity-search-toggle"
        aria-label="收起此面板"
        title="收起此面板"
        onClick={onCollapse}
      >
        <PanelRightClose size={14} strokeWidth={2.25} />
      </button>
      {asideToggle}
    </span>
  );

  if (selecting) {
    return (
      <WorkRail
        idle={false}
        glyphs={[
          <span key="select" className="kd-activity-glyph kd-activity-glyph-sel" aria-hidden="true">
            <CheckSquare size={13} strokeWidth={2.25} />
          </span>,
        ]}
        texts={[
          <WorkRailSelection
            key="selection"
            count={selectedIds.length}
            onSelectAll={() => usePlaylistStore.getState().selectAllTracks()}
            onClear={() => usePlaylistStore.getState().selectTrack(null)}
            onDone={() => usePlaylistStore.getState().selectTrack(null)}
            actions={
              writable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selectedIds.length === 0}
                  onClick={() => void removeTracks(selectedIds).catch(() => undefined)}
                >
                  <Trash2 size={12} /> 从列表移除
                </Button>
              ) : undefined
            }
          />,
        ]}
        trailing={trailing}
        label="OneLibrary 多选"
      />
    );
  }

  return (
    <WorkRail
      idle={!busy}
      glyphs={[
        <span key="device" className="kd-activity-glyph" aria-hidden="true">
          {target.is_virtual ? <HardDrive size={13} /> : <Usb size={13} />}
        </span>,
        <span key="list" className="kd-activity-glyph" aria-hidden="true">
          {busy ? <LoaderCircle className="kd-spin" size={13} /> : <ListMusic size={13} />}
        </span>,
      ]}
      texts={[
        <span key="device" className="kd-activity-text kd-truncate">{target.device_name}</span>,
        <span key="list" className="kd-activity-text kd-truncate">
          {target.playlist_name} · {tracks.length} 首
        </span>,
      ]}
      trailing={trailing}
      label="OneLibrary 列表"
    />
  );
}
