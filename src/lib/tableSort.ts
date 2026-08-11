export type TableSortOrder = "asc" | "desc";

export interface TableSortState<T extends string> {
  sort: T;
  order: TableSortOrder;
  sort2: T | null;
  order2: TableSortOrder;
}

/**
 * 曲目表统一的三态排序：主键升序 → 降序 → 取消；另一列先成为副键，
 * 再点副键时与主键互换。defaultSort 表示这张表自己的原始顺序。
 */
export function cycleTableSort<T extends string>(
  state: TableSortState<T>,
  column: T,
  defaultSort: T,
  defaultOrder: TableSortOrder,
): TableSortState<T> {
  const { sort, order, sort2, order2 } = state;
  const hasPrimary = sort !== defaultSort;

  if (column === sort) {
    if (order === "asc") return { ...state, order: "desc" };
    if (sort2) {
      return { sort: sort2, order: order2, sort2: null, order2: "asc" };
    }
    return { sort: defaultSort, order: defaultOrder, sort2: null, order2: "asc" };
  }

  if (column === sort2) {
    return { sort: sort2, order: order2, sort2: sort, order2: order };
  }

  return hasPrimary
    ? { ...state, sort2: column, order2: "asc" }
    : { ...state, sort: column, order: "asc" };
}

export function tableSortTitle<T extends string>(
  state: TableSortState<T>,
  column: T,
): string {
  if (column === state.sort) {
    return state.order === "asc"
      ? "再点换为降序；拖动列头可调整顺序"
      : "再点取消排序；拖动列头可调整顺序";
  }
  if (column === state.sort2) {
    return "副排序键；再点升为主排序，拖动可调整列顺序";
  }
  return "点一下按它排；拖动列头可调整顺序";
}
