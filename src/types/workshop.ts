export interface WorkshopSource {
  kind?: "audio" | "video" | "image" | "gif" | "";
  frame_ends_ms?: number[];
  id: string;
  track_id: number;
  path: string;
  title: string;
  duration_ms: number;
  video: boolean;
  audio: boolean;
  width: number;
  height: number;
  fps: number;
  signature: string;
}
export interface ClipSpeed {
  preset: "constant" | "ramp" | "pulse";
  start: number;
  middle: number;
  end: number;
  domain_start_ms: number;
  domain_end_ms: number;
}
export interface ClipPicture {
  rotation?: number;
  flip_x?: boolean;
  flip_y?: boolean;
  crop?: [number, number, number, number];
  x: number;
  y: number;
  scale: number;
  opacity: number;
}
export interface ClipSound {
  muted: boolean;
  gain: number;
  manual: boolean;
}
export interface ClipFades {
  offset_ms: number;
  span_ms: number;
  video_in_ms: number;
  video_out_ms: number;
  audio_in_ms: number;
  audio_out_ms: number;
  linear: boolean;
}
export interface VideoTransition {
  duration_ms: number;
  alignment: -1 | 0 | 1;
}
export interface WorkshopClip {
  video_transition?: VideoTransition | null;
  display_duration_ms?: number | null;
  animation_offset_ms?: number;
  id: string;
  source_id: string;
  start_ms: number;
  source_in_ms: number;
  source_out_ms: number;
  speed: ClipSpeed;
  picture: ClipPicture;
  sound: ClipSound;
  fades: ClipFades;
}
export interface WorkshopLayer {
  grid?: WorkshopBeatGrid | null;
  id: string;
  source_id: string;
  clips: WorkshopClip[];
}
export interface WorkshopCanvas {
  import_picture?: Pick<ClipPicture, "x" | "y" | "scale" | "opacity"> | null;
  width: number;
  height: number;
  fps: number;
  initialized: boolean;
}
export interface WorkshopOutput {
  format?: "mp4" | "wav" | "flac" | "mp3";
  name: string;
  directory: string;
  in_ms: number;
  out_ms: number | null;
  quality: number;
  acceleration:
    "auto" | "software" | "video_toolbox" | "nvidia" | "intel" | "amd";
}
export interface WorkshopMarker {
  id: string;
  position_ms: number;
  number: number;
}
export interface CompositionProject {
  markers?: WorkshopMarker[];
  id: string;
  revision: number;
  name: string;
  sources: WorkshopSource[];
  layers: WorkshopLayer[];
  canvas: WorkshopCanvas;
  output: WorkshopOutput;
  migrated_from: string | null;
}
export interface WorkshopJob {
  id: string;
  project_id: string;
  revision: number;
  phase: string;
  progress: number;
  detail?: string;
  error: string;
  path: string;
  track_id: number | null;
}
export interface WorkshopSnapshot {
  session: string;
  revision: number;
  projects: CompositionProject[];
  jobs: WorkshopJob[];
}
export type WorkshopEdit = Pick<
  CompositionProject,
  "name" | "layers" | "canvas" | "output" | "markers"
>;
export type ClipHandle = "move" | "in" | "out" | "fade_in" | "fade_out" | "audio_fade_in" | "audio_fade_out";

export interface WorkshopPlacement {
  clip_id: string;
  source_in_ms: number;
  source_out_ms: number;
  start_ms: number;
  speed_multiplier?: number;
}
export interface WorkshopPositionPreset {
  id: string;
  label: string;
  prerequisite?: string | null;
  placements: WorkshopPlacement[];
}
export interface WorkshopPositionAnalysis {
  id: string;
  layer_id: string;
  phase: "waiting" | "analyzing" | "ready" | "unmatched" | "failed" | "stopped";
  progress: number;
  reference_id: string;
  reference_title: string;
  reason: string;
  presets: WorkshopPositionPreset[];
  applied: string | null;
}
export interface WorkshopPositionResults {
  session: string;
  project_id: string;
  revision: number;
  items: WorkshopPositionAnalysis[];
}

export interface WorkshopIntake { project_id: string | null; revision?: number; track_ids: number[]; paths: string[]; at_ms: number; }
export interface WorkshopIntakeResult { snapshot: WorkshopSnapshot; before: CompositionProject | null; project_id: string | null; errors: string[]; }
export interface WorkshopNativeDrop { id: number; phase: "enter" | "over" | "drop" | "leave"; x: number; y: number; paths: string[]; folders?: string[]; error?: string | null; }

export interface TempoSegment { start_seconds: number; end_seconds: number; bpm: number; confidence: number; }
export interface RhythmAnalysis { audio_offset_seconds?: number; revision: string; precise: boolean; duration: number; bpm: number | null; confidence: number; beats: number[]; downbeats: number[]; downbeat_confidence: number; segments: TempoSegment[]; coverage: [number, number][]; }
export interface RhythmResponse { analysis: RhythmAnalysis | null; status: {job_id: string; phase: string; error: string} | null; }
export interface WorkshopBeatGrid { analysis_revision: string; source_signature: string; beats: number[]; downbeats: number[]; segments: TempoSegment[]; beats_per_bar: number; downbeat_confidence: number; locked: boolean; }
