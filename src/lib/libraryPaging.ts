export interface LibraryPageControl {
  cursor?: string;
  /** Axum/Serde accepts query booleans as `true` / `false`, not `1` / `0`. */
  include_total: "true" | "false";
}

/** Keep the continuation token and total-count policy encoded as one protocol unit. */
export function libraryPageControl(cursor: string | null): LibraryPageControl {
  return cursor
    ? { cursor, include_total: "false" }
    : { include_total: "true" };
}
