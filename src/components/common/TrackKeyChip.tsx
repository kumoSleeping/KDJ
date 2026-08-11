import type { CSSProperties } from "react";
import { camelotColor } from "../../lib/camelot";
import { canonicalTrackCamelot, displayTrackKey, type TrackKeyFields } from "../../lib/keyDisplay";
import type { KeyNotation } from "../../types";

export function TrackKeyChip({
  track,
  notation,
}: {
  track: TrackKeyFields;
  notation: KeyNotation;
}) {
  const code = canonicalTrackCamelot(track);
  const label = displayTrackKey(track, notation);
  if (!label) {
    return (
      <span className="kd-camelot" data-empty="true">
        —
      </span>
    );
  }
  return (
    <span
      className="kd-camelot"
      style={code ? ({ "--kd-key-color": camelotColor(code) } as CSSProperties) : undefined}
    >
      {label}
    </span>
  );
}
