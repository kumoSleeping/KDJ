import type { CompositionProject } from "../types/workshop";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keyed = (v: unknown[]): v is Array<Record<string, unknown> & {id: string}> => v.every(item => object(item) && typeof item.id === "string");

/** Rebase an edit, not an old full snapshot, onto the latest imported/analyzed project. */
function merge(base: unknown, edited: unknown, current: unknown, field: string): unknown {
  if (equal(base, edited)) return structuredClone(current);
  if (equal(base, current) || equal(edited, current)) return structuredClone(edited);
  if (Array.isArray(base) && Array.isArray(edited) && Array.isArray(current) && keyed(base) && keyed(edited) && keyed(current)) {
    const before = new Map(base.map(v => [v.id, v])), after = new Map(edited.map(v => [v.id, v])), latest = new Map(current.map(v => [v.id, v]));
    const oldOrder = base.filter(v => after.has(v.id)).map(v => v.id);
    const editOrder = edited.filter(v => before.has(v.id)).map(v => v.id);
    const currentOrder = current.filter(v => before.has(v.id) && after.has(v.id)).map(v => v.id);
    const reordered = !equal(oldOrder, editOrder);
    if (reordered && !equal(currentOrder, oldOrder) && !equal(currentOrder, editOrder)) throw new Error(`作品已更新，${field}顺序发生冲突，请重试`);
    const ids = [...new Set((reordered ? [...edited, ...current] : [...current, ...edited]).map(v => v.id))];
    return ids.flatMap(id => {
      const value = merge(before.get(id), after.has(id) ? after.get(id) : before.has(id) ? undefined : latest.get(id), latest.get(id), field);
      return value === undefined ? [] : [value];
    });
  }
  if (object(base) && object(edited) && object(current)) {
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(edited), ...Object.keys(current)])].map(key =>
      [key, merge(base[key], edited[key], current[key], field)]));
  }
  throw new Error(`作品已更新，${field}发生冲突，请重试`);
}

export function rebaseWorkshopEdit(base: CompositionProject, edited: CompositionProject, current: CompositionProject): CompositionProject {
  const next = structuredClone(current);
  const labels = {name: "作品名称", layers: "轨道", canvas: "画布设置", output: "导出设置", markers: "标记"};
  for (const field of ["name", "layers", "canvas", "output", "markers"] as const) {
    Object.assign(next, {[field]: merge(field === "markers" ? base[field] ?? [] : base[field],
      field === "markers" ? edited[field] ?? [] : edited[field], field === "markers" ? current[field] ?? [] : current[field], labels[field])});
  }
  return next;
}
