import { isOutsideFolder } from "../../lib/outsideFolder";
import type { FolderNode, FolderTree } from "../../types";

/** What the local list is showing, as the rail names it: the sidebar's own name and number. */
export interface LibraryRailView {
  /** Changes when the list is another list; the rail turns the name over on it. */
  key: string;
  name: string;
  /** Tracks in it, sub-folders included; null while the tree does not know the folder. */
  count: number | null;
  /** The folder's path, for the tooltip; empty for the views that are not one folder. */
  path: string;
}

const samePath = (a: string, b: string) =>
  a === b || a.replaceAll("\\", "/").replace(/\/+$/, "") === b.replaceAll("\\", "/").replace(/\/+$/, "");

function findFolder(nodes: readonly FolderNode[], path: string): FolderNode | null {
  for (const node of nodes) {
    if (samePath(node.path, path)) return node;
    const inside = findFolder(node.children, path);
    if (inside) return inside;
  }
  return null;
}

/**
 * `folder` is `filter.folder` of the library store: empty for the whole library, the
 * outside-folder sentinel for 「其他」, otherwise a directory. The names are the sidebar's
 * (`FolderTree.tsx`): 全部曲目, 其他, and a folder's own name as the tree shows it.
 */
export function libraryRailView(
  folder: string,
  folders: FolderTree | null,
  libraryTotal: number | null,
): LibraryRailView {
  if (!folder) {
    const counted = folders
      ? folders.roots.reduce((sum, root) => sum + root.total_count, 0) + folders.outside
      : null;
    return { key: "all", name: "全部曲目", count: libraryTotal ?? counted, path: "" };
  }
  if (isOutsideFolder(folder)) {
    return { key: "outside", name: "其他", count: folders ? folders.outside : null, path: "" };
  }
  const node = folders ? findFolder(folders.roots, folder) : null;
  return {
    key: `folder:${folder}`,
    name: node?.name || folder.split(/[\\/]/).filter(Boolean).at(-1) || folder,
    count: node ? node.total_count : null,
    path: folder,
  };
}
