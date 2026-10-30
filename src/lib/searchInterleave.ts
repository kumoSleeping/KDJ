import type { CollectionResult, IntakeItem, MergedGroup } from "../types";

/** The source a group stands for: one song found by two lines is listed once. */
function groupKey(group: MergedGroup): string {
  const best = group.sources[group.best_source_index] ?? group.sources[0];
  return best ? `${best.platform}:${best.key}` : group.group_id;
}

/** Takes one from each list in turn until every list is spent. */
function alternate<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map(list => list.length));
  for (let at = 0; at < longest; at += 1) for (const list of lists) if (at < list.length) out.push(list[at]);
  return out;
}

/**
 * Several keywords, one per line (Shift + Enter), are searched together and shown as one list:
 * the answers interleaved — the first of each line, then the second of each — with a song found
 * by two lines listed once. Lines that are links or anything other than a keyword search keep
 * their own packages, as before.
 */
export function interleaveSearches(items: readonly IntakeItem[]): IntakeItem[] {
  if (items.length < 2 || !items.every(item => item.kind === "search")) return [...items];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const groups: MergedGroup[] = [];
  for (const group of alternate(items.map(item => item.groups))) {
    const key = groupKey(group);
    if (seen.has(key)) continue;
    seen.add(key);
    // Each line's search numbers its groups on its own; the merged list keeps them apart.
    let id = group.group_id;
    for (let n = 2; ids.has(id); n += 1) id = `${group.group_id}#${n}`;
    ids.add(id);
    groups.push(id === group.group_id ? group : { ...group, group_id: id });
  }
  const collectionKeys = new Set<string>();
  const collections: CollectionResult[] = alternate(items.map(item => item.collections)).filter(collection => {
    const key = `${collection.platform}:${collection.kind}:${collection.key}`;
    if (collectionKeys.has(key)) return false;
    collectionKeys.add(key);
    return true;
  });
  const errors: Record<string, string> = {};
  for (const item of items) for (const [platform, message] of Object.entries(item.errors)) errors[platform] ??= message;
  const entry = items.map(item => item.entry).join(" / ");
  return [{ entry, kind: "search", platform: null, title: entry, groups, collections, errors, error: "" }];
}
