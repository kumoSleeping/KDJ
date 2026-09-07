import type { CompositionProject } from "../types/workshop";
import { clamp, projectDuration, uid } from "./workshop";

const colors = ["#e45b65", "#df913c", "#b7a52e", "#4aa879", "#399fc2", "#737cda", "#b46bc5"];
export const workshopMarkerColor = (number: number) => colors[(number - 1) % colors.length];

export function addWorkshopMarker(p: CompositionProject, ms: number): CompositionProject {
  if (!Number.isFinite(ms)) return p;
  const markers = p.markers ?? [];
  const position_ms = Math.round(clamp(ms, 0, Math.min(21_600_000, projectDuration(p))) * 1000) / 1000;
  if (markers.some(m => Math.abs(m.position_ms - position_ms) < .001)) return p;
  const number = Math.max(0, ...markers.map(m => m.number)) + 1;
  return {...p, markers: [...markers, {id: uid(), position_ms, number}]};
}

export function removeWorkshopMarker(p: CompositionProject, id: string): CompositionProject {
  return {...p, markers: (p.markers ?? []).filter(m => m.id !== id)};
}
