/**
 * A capacitive jog hold is a momentary transport gesture, not a Play/Pause toggle.
 * Remembering the physical Deck and a generation prevents a late note-off from reviving a
 * replacement source or a newer scratch gesture.
 */
export interface MidiScratchHold {
  generation: number;
  trackId: number;
  resumeOnRelease: boolean;
}

export function beginMidiScratchHold(
  generation: number,
  trackId: number,
  playing: boolean,
): MidiScratchHold {
  return { generation, trackId, resumeOnRelease: playing };
}

export function canResumeMidiScratchHold(
  hold: MidiScratchHold | null,
  generation: number,
  trackId: number | null,
): boolean {
  return Boolean(
    hold
      && hold.generation === generation
      && hold.trackId === trackId
      && hold.resumeOnRelease,
  );
}
