export type CompositionPhase = "waiting_pair" | "pending_analysis" | "analyzing" | "ready" |
  "needs_review" | "queued" | "rendering" | "validating" | "committing" | "importing" |
  "import_failed" | "failed" | "canceled";
export type CompositionLane = "video" | "audio";
export interface OverlayOptions {
  scale: number; x: number; y: number; opacity: number; fade_ms: number;
  audio: "main" | "replace_segment" | "mix";
}
export interface CompositionSegment { source_start_ms: number; source_end_ms: number | null }
export interface CompositionAudio { mode: "replace" | "mix"; gain: number; main_gain: number; fade_in_ms: number; fade_out_ms: number }
export interface CompositionOptions {
  output_mode: "new_file" | "overwrite";
  length_policy: "keep_video" | "full_audio";
  alignment_mode?: "sections" | "single_offset";
  output_dir: string;
  overlay: OverlayOptions;
  acceleration: "auto" | "software" | "video_toolbox" | "nvidia" | "intel" | "amd";
  segment: CompositionSegment;
  audio: CompositionAudio;
}
export interface CompositionEntry {
  id: string; track_id: number; path: string; title: string; artist: string;
  format: string; is_video: boolean; duration_ms: number; options: CompositionOptions;
}
export interface CompositionTimeline {
  start_ms: number; duration_ms: number; video_start_ms: number; audio_start_ms: number;
  silence_head_ms: number; silence_tail_ms: number; crop_head_ms: number; crop_tail_ms: number;
  black_head_ms: number; black_tail_ms: number;
}
export interface CompositionVideoSection { audio_start_ms: number; video_start_ms: number; duration_ms: number }
export interface CompositionTask {
  id: string; video: CompositionEntry | null; audio: CompositionEntry | null;
  phase: CompositionPhase; generation: number; released: boolean; busy: boolean;
  offset_ms: number | null; matched: boolean; force_confirmed: boolean;
  video_duration_ms: number | null; audio_duration_ms: number | null;
  timeline: CompositionTimeline | null; progress: number | null; error: string; output_path: string;
  video_sections?: CompositionVideoSection[];
}
export interface CompositionSnapshot {
  session_id: string;
  revision: number; tasks: CompositionTask[]; defaults: CompositionOptions;
}
export interface CompositionPatch {
  generation: number; options?: CompositionOptions; offset_ms?: number; force_confirmed?: boolean;
}
