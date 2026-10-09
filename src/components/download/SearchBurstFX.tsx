import type { Platform } from "../../types";

/**
 * The canvas burst that used to play here is gone: a running search is now the line under the
 * field (SearchBar.css). Workspace still imports this tone helper and passes the result as
 * `burstTone`, which SearchBar ignores; remove both together with that prop.
 */
export type SearchBurstTone = "rainbow" | "pink" | "orange" | "red" | "green";

/** @deprecated See the note above. */
export function burstToneForPlatforms(platforms: readonly Platform[]): SearchBurstTone {
  if (platforms.length !== 1) return "rainbow";
  switch (platforms[0]) {
    case "bilibili":
      return "pink";
    case "soundcloud":
      return "orange";
    case "wyy":
    case "ytm":
    case "youtube":
      return "red";
    case "qqm":
      return "green";
    default:
      return "rainbow";
  }
}
