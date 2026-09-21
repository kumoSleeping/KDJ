import { DEFAULT_STUDIO_LEFT_VEIL, hasStudioLyrics, validateVisualizerProject, type VisualizerProject } from "./visualizerStudio";

const KEY = "kdj-visualizer-preferences-v1";
type Layout = NonNullable<VisualizerProject["leftContent"]>;
type LayoutMode = "lyrics" | "information";
interface Preferences {
  version: 1 | 2 | 3 | 4;
  scene: Pick<VisualizerProject["scene"], "canvas" | "arc" | "spectrum"> & { disc: Omit<VisualizerProject["scene"]["disc"], "image"> };
  look: Omit<VisualizerProject["look"], "leftFit" | "rightFit">;
  text: Pick<VisualizerProject["text"], "visible" | "showAlbum" | "scale" | "font" | "progress">;
  lyrics: { enabled: boolean; size: number; showTranslation?: boolean };
  output: Omit<VisualizerProject["output"], "filename">;
  layouts: Record<LayoutMode, Layout>;
}
const defaultLayout = (): Layout => ({ x: 0, y: 0, scale: 1 });
const mode = (p: VisualizerProject): LayoutMode => hasStudioLyrics(p.lyrics.lrc) && p.lyrics.mode !== "off" ? "lyrics" : "information";
let memory: Preferences | undefined;
let persisted = "";

/** Apply presentation preferences without copying another song's content or crop. */
export function applyVisualizerPreferences(p: VisualizerProject, settings: Preferences): void {
  const s = structuredClone(settings);
  p.scene.canvas = s.scene.canvas; p.scene.arc = s.scene.arc; p.scene.spectrum = s.scene.spectrum;
  p.scene.disc = { ...s.scene.disc, image: p.scene.disc.image };
  const { leftFit, rightFit } = p.look;
  p.look = { ...s.look, leftFit, rightFit };
  p.text = { ...p.text, visible: s.text.visible, showAlbum: s.text.showAlbum ?? false, scale: s.text.scale, font: s.text.font, progress: s.text.progress };
  p.lyrics.size = s.lyrics.size;
  p.lyrics.showTranslation = s.lyrics.showTranslation ?? true;
  p.lyrics.mode = s.lyrics.enabled && hasStudioLyrics(p.lyrics.lrc) ? "scroll" : "off";
  p.output = { ...s.output, filename: p.output.filename };
  p.leftContent = s.layouts[mode(p)];
}

export function loadVisualizerPreferences(project: VisualizerProject): Preferences | undefined {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return;
    const value: Preferences = JSON.parse(raw);
    if (![1, 2, 3, 4].includes(value.version) || typeof value.lyrics.enabled !== "boolean" || typeof value.text.visible !== "boolean" || typeof value.text.progress !== "boolean" || typeof value.output.directory !== "string") return;
    if (value.version < 4) {
      // Update each former default once; keep non-default darkening unchanged.
      const previousDefault = value.version === 1 ? .32 : value.version === 2 ? .22 : .17;
      if (value.look.leftVeil === previousDefault) value.look.leftVeil = DEFAULT_STUDIO_LEFT_VEIL;
      value.version = 4;
    }
    const candidate = structuredClone(project);
    applyVisualizerPreferences(candidate, value);
    // Image assignments are song-specific, not part of these preferences.
    candidate.scene.images = ["image:0"];
    candidate.scene.left.image = candidate.scene.right.image = candidate.scene.disc.image = 0;
    for (const kind of ["lyrics", "information"] as const) {
      const layout = value.layouts[kind];
      if (!layout) return;
      candidate.leftContent = layout; validateVisualizerProject(candidate);
    }
    memory = value; persisted = raw;
    return memory;
  } catch { return; }
}

/** Synchronous small writes let a song switch see the latest gesture immediately. */
export function saveVisualizerPreferences(p: VisualizerProject, resetLayouts = false): void {
  const previous = loadVisualizerPreferences(p);
  const { image: _image, ...disc } = p.scene.disc;
  const { leftFit: _leftFit, rightFit: _rightFit, ...look } = p.look;
  const { filename: _filename, ...output } = p.output;
  const layouts = !resetLayouts && previous ? structuredClone(previous.layouts) : { lyrics: defaultLayout(), information: defaultLayout() };
  layouts[mode(p)] = { ...(p.leftContent ?? defaultLayout()) };
  memory = structuredClone({
    version: 4,
    scene: { canvas: p.scene.canvas, arc: p.scene.arc, spectrum: p.scene.spectrum, disc },
    look,
    text: { visible: p.text.visible, showAlbum: p.text.showAlbum ?? false, scale: p.text.scale, font: p.text.font, progress: p.text.progress },
    lyrics: { enabled: hasStudioLyrics(p.lyrics.lrc) ? p.lyrics.mode !== "off" : previous?.lyrics.enabled ?? true, size: p.lyrics.size, showTranslation: p.lyrics.showTranslation ?? true },
    output, layouts,
  });
  const raw = JSON.stringify(memory);
  if (raw !== persisted) { localStorage.setItem(KEY, raw); persisted = raw; }
}

/** Toggling lyrics selects the other remembered layout, rather than overwriting it. */
export function switchVisualizerContentLayout(next: VisualizerProject, previous: VisualizerProject): void {
  if (mode(next) === mode(previous)) return;
  next.leftContent = { ...(loadVisualizerPreferences(previous)?.layouts[mode(next)] ?? defaultLayout()) };
}
