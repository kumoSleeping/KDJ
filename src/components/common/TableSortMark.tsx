import type { TableSortOrder } from "../../lib/tableSort";

export function TableSortMark({
  order,
  secondary = false,
}: {
  order: TableSortOrder;
  secondary?: boolean;
}) {
  return (
    <span className="kd-sort-mark" aria-label={secondary ? "副排序" : "主排序"}>
      {order === "asc" ? "↑" : "↓"}
    </span>
  );
}
