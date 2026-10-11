import { Fragment, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { isOutsideFolder } from "../../lib/outsideFolder";
import { useLibraryStore } from "../../stores/libraryStore";
import type { FolderNode } from "../../types";

/** The folders from a library root down to `path`, or null when the tree does not hold it. */
function chainTo(nodes: readonly FolderNode[], path: string): FolderNode[] | null {
  for (const node of nodes) {
    if (node.path === path) return [node];
    const below = chainTo(node.children, path);
    if (below) return [node, ...below];
  }
  return null;
}

/**
 * The bar the library's list stands on (InsetSurfaces.css): where the list is — the way down
 * from the library root, each step a key back to that folder — and how many songs it holds.
 * It is there whatever the list holds, so the list's last row always ends at it and never at
 * the window's edge. It says what is, and nothing else: no hints, no actions of its own.
 */
export function LibraryFootBar() {
  const folder = useLibraryStore(state => state.filter.folder);
  const folders = useLibraryStore(state => state.folders);
  const total = useLibraryStore(state => state.total);
  const picked = useLibraryStore(state => state.selectedIds.length);
  const setFilter = useLibraryStore(state => state.setFilter);
  const chain = useMemo(
    () => folder && !isOutsideFolder(folder) && folders ? chainTo(folders.roots, folder) : null,
    [folder, folders],
  );
  // A folder the tree does not know (yet): its own name is all that can be said of it.
  const alone = !folder ? "曲库" : isOutsideFolder(folder) ? "其他" : folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  return <footer className="kd-list-foot">
    <nav className="kd-list-foot-path" aria-label="当前位置">
      {chain
        ? chain.map((node, index) => <Fragment key={node.path}>
          {index > 0 && <ChevronRight size={11} aria-hidden="true" />}
          {index < chain.length - 1
            ? <button type="button" title={node.path} onClick={() => setFilter({ folder: node.path })}>{node.name}</button>
            : <span aria-current="location" title={node.path}>{node.name}</span>}
        </Fragment>)
        : <span aria-current="location">{alone}</span>}
    </nav>
    <span className="kd-list-foot-count">
      {total.toLocaleString()} 首{picked > 1 ? ` · 已选 ${picked.toLocaleString()}` : ""}
    </span>
  </footer>;
}
