import { LibrarySearchTools, WorkRailCollapse } from "../chrome/WorkRailControls";
import { WorkRail } from "../chrome/WorkRail";
import { useEffect } from "react";
import { useStore } from "zustand";
import { Folder } from "lucide-react";
import type { TemporaryLibrary } from "../../stores/temporaryLibraryStore";
import type { SelectMode } from "../../stores/libraryStore";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { FOLDER_DROP_PATH_ATTR, SEARCH_DROP_PATH_ATTR } from "../../lib/folderDrop";
import { enqueueSearchDrop, isSearchDownloadDrag } from "../../lib/searchDrag";
import { TrackTable } from "./TrackTable";
import { InlineNotice } from "../common";

export function TemporaryFolderPane({ library, active, shown = true, visible = true, layout, onSelect, onClose }: {
  library: TemporaryLibrary;
  active: boolean;
  /** False while its pane is hidden; see `WorkRail`. */
  shown?: boolean;
  /** Whether the pane this folder is in is the shown one: its list arrives again each time it is. */
  visible?: boolean;
  layout: LayoutMode;
  onSelect(id: number, mode: SelectMode, clickCount?: number): void;
  onClose(): void;
}) {
  const state = useStore(library.store);
  const folder = state.filter.folder;
  useEffect(() => library.mount(), [library]);
  return <div className="kd-temporary-folder-content"
    {...{ [FOLDER_DROP_PATH_ATTR]: folder, [SEARCH_DROP_PATH_ATTR]: folder }}
    onDragOver={(event) => {
      if (!isSearchDownloadDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }}
    onDrop={(event) => {
      if (!isSearchDownloadDrag(event)) return;
      event.preventDefault();
      void enqueueSearchDrop(event, folder).catch((error: unknown) => library.store.setState({ error: String(error) }));
    }}
  >
    <WorkRail idle={!state.loading} label="临时文件夹" shown={shown}
      glyphs={[<Folder key="folder" size={13} aria-hidden="true" />]}
      texts={[
        <span key="title" className="kd-activity-text kd-collection-rail-title" title={folder}>
          {folder.split(/[\\/]/).filter(Boolean).at(-1)}
        </span>,
        <span key="count" className="kd-collection-rail-count">{state.total} 首</span>,
      ]}
      trailing={<LibrarySearchTools value={state.filter.q} folder={folder}
        selecting={state.selectionMode || state.selectedIds.length > 1}
        onChange={(value) => state.setFilter({ q: value })} />}
      actions={<WorkRailCollapse label="收起临时文件夹" onClick={onClose} />}
    />
    {state.error && <div className="kd-toolbar">
      <InlineNotice text={state.error} />
      <button type="button" onClick={() => void state.retryList()}>重试</button>
    </div>}
    <TrackTable libraryStore={library.store} persistentSession={false} layout={layout}
      total={state.total} loading={state.loading} selectedId={state.selectedId} selectedIds={state.selectedIds}
      shortcutActive={active} visible={visible} sort={state.filter.sort} order={state.filter.order}
      sort2={state.filter.sort2} order2={state.filter.order2} onSelect={onSelect} onSort={state.cycleSort} />
  </div>;
}
