/**
 * A draft's forks as the ask bubble draws them (ask_user's `timeline`, kdj-timeline.ts on the
 * AI's side): the draft's lanes with each fork filled by the option picked now, the bars the
 * ruler names, and what the preview shows. Seconds of the project throughout.
 */

export interface TimelineClip { at: number; length: number; label: string; kind: string }
export interface TimelineOption { id: string; label: string; note: string; frames: (string | null)[]; clips: TimelineClip[] }
export interface TimelineFork {
  id: string; kind: string; question: string; from_bar: number; to_bar: number; track: number;
  start: number; end: number; default: string;
  /** Frames' keys: null when there is no such moment, "" when nothing is on screen. */
  before: string | null; after: string | null;
  options: TimelineOption[];
}
export interface AskTimeline {
  project: string; title: string; duration: number;
  bars: { n: number; at: number }[];
  /** Track 0 is the top one. */
  tracks: TimelineClip[][];
  forks: TimelineFork[];
  /** Pictures by key, as data addresses. */
  frames: Record<string, string>;
}

/** A clip on a lane, and whether it is a fork's filling. */
export interface LaneClip extends TimelineClip { filled: boolean }

/**
 * The lanes as they will be with `picks`: on a fork's track the draft's clips are cut away from
 * the fork's place, and the picked option's clips are laid there.
 */
export function laneView(timeline: AskTimeline, picks: Readonly<Record<string, string>>): LaneClip[][] {
  return timeline.tracks.map((clips, track) => {
    const places = timeline.forks.filter(fork => fork.track === track);
    const out: LaneClip[] = [];
    for (const clip of clips) {
      let pieces: [number, number][] = [[clip.at, clip.at + clip.length]];
      for (const fork of places) {
        pieces = pieces.flatMap(([from, to]): [number, number][] => {
          if (to <= fork.start || from >= fork.end) return [[from, to]];
          return [[from, Math.min(to, fork.start)], [Math.max(from, fork.end), to]].filter(([a, b]) => b - a > 0.01) as [number, number][];
        });
      }
      for (const [from, to] of pieces) out.push({ ...clip, at: from, length: to - from, filled: false });
    }
    for (const fork of places) {
      const option = fork.options.find(item => item.id === picks[fork.id]);
      for (const clip of option?.clips ?? []) out.push({ ...clip, filled: true });
    }
    return out.sort((a, b) => a.at - b.at);
  });
}

/** Every how many bars the ruler names one, so that about a dozen names fit. */
export function rulerStep(bars: number): number {
  for (const step of [1, 2, 4, 8, 16, 32, 64]) if (bars / step <= 12) return step;
  return 128;
}

/** m:ss of the project. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The five pictures of a fork with an option: just before, three inside, just after. */
export function forkStrip(fork: TimelineFork, option: TimelineOption): { key: string | null; caption: string }[] {
  return [
    { key: fork.before, caption: "前一刻" },
    ...option.frames.map((key, n) => ({ key, caption: ["开头", "中间", "结尾"][n] ?? "" })),
    { key: fork.after, caption: "后一刻" },
  ];
}
