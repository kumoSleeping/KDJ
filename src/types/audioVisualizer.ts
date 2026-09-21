/** Mirrors kdj_core::audio_visualizer, scene version 1. No playback-store references. */
export interface VisualizerImageTransform {
  image: number;
  focus_x: number;
  focus_y: number;
  zoom: number;
  rotation_deg: number;
  mirror_x: boolean;
  mirror_y: boolean;
  blur: number;
}
export interface AudioVisualizerScene {
  version: 1;
  canvas: { width: number; height: number; fps: 30 };
  images: string[];
  left: VisualizerImageTransform;
  right: VisualizerImageTransform;
  arc: { position: number; bend: number };
  disc: { mode: "hidden" | "disc" | "cover"; image: number; x: number; y: number; size: number; rpm: number; direction: -1 | 1 };
  spectrum: { bands: number; length: number; sensitivity: number; smoothing: number; color: [number, number, number, number] };
}
export interface VisualizerFeatureFrame {
  bands: number[];
  bass: number;
  rms: number;
  onset: number;
}
export interface VisualizerFeatureTimeline {
  version: 1;
  sample_rate: number;
  sample_count: number;
  fps: 30;
  frames: VisualizerFeatureFrame[];
}
