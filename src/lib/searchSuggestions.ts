import type { TrackSummary } from "../types";
import { buildVjQuery } from "./vjKeywords";

/** Show each search phrase once, with selection before playback. */
export function buildSearchSuggestions(selected?: TrackSummary | null, playing?: TrackSummary | null) {
  const seen = new Set<string>();
  return [selected, playing].flatMap(track => {
    if (!track) return [];
    const title = buildVjQuery(track.title || track.filename, "", [], false).trim();
    if (!title) return [];
    const artist = track.artist.trim();
    return [title, ...(artist ? [`${title} ${artist}`] : [])].flatMap(label => {
      if (seen.has(label)) return [];
      seen.add(label);
      return [{ id: label, label }];
    });
  });
}
