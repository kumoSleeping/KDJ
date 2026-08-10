import type { OneLibraryPlaylist } from "../types";

export type OneLibraryTreeDropEdge = "before" | "after" | "inside";

/** 把树上视觉落点换成 rbox OneLibrary 的零基 sequence。 */
export function oneLibraryTreeDropPosition(
  source: Pick<OneLibraryPlaylist, "parent_id" | "seq">,
  target: Pick<OneLibraryPlaylist, "id" | "parent_id" | "seq">,
  edge: OneLibraryTreeDropEdge,
): { parentId: number; sequence: number | null } {
  if (edge === "inside") return { parentId: target.id, sequence: null };
  const sameParent = source.parent_id === target.parent_id;
  const targetAfterSource = sameParent && source.seq < target.seq;
  return {
    parentId: target.parent_id,
    sequence: Math.max(
      0,
      target.seq - (targetAfterSource ? 1 : 0) + (edge === "after" ? 1 : 0),
    ),
  };
}
