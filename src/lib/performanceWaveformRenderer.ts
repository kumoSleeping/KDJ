import { cueColor, waveformLoopRegions } from "./cuePoints";
import { waveformDisplayRgb } from "./waveformPalette";
import type { CuePoint, Waveform } from "../types";

export interface PerformanceWaveRenderLane {
  key: string;
  top: number;
  height: number;
  waveform: Waveform | null;
  placeholder?: Waveform | null;
  opacity?: number;
  silenceThreshold?: number;
  verticalInsetRatio?: number;
}

export interface PerformanceWaveRenderModel {
  duration: number;
  viewportSeconds: number;
  lanes: PerformanceWaveRenderLane[];
  bpm: number | null;
  firstBeat: number | null;
  bpmConfidence: number | null;
  cuePoints: readonly CuePoint[];
  cueMs: number | null;
  endMs: number | null;
  loopStart: number | null;
  loopLength: number | null;
}

interface WaveTexture {
  color: WebGLTexture;
  known: WebGLTexture;
  width: number;
  height: number;
  count: number;
}

export interface PackedPerformanceWaveformTexture {
  colorBytes: Uint8Array;
  knownBytes: Uint8Array;
  width: number;
  height: number;
  count: number;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_wave;
uniform sampler2D u_known;
uniform sampler2D u_placeholder;
uniform ivec2 u_wave_size;
uniform ivec2 u_placeholder_size;
uniform int u_wave_count;
uniform int u_placeholder_count;
uniform float u_position;
uniform float u_duration;
uniform float u_view_seconds;
uniform float u_output_width;
uniform float u_output_height;
uniform float u_inset;
uniform float u_silence;
uniform float u_opacity;
uniform float u_motion_seconds;
uniform bool u_has_placeholder;

ivec2 sample_coord(int index, ivec2 size) {
  int safe_index = max(0, index);
  return ivec2(safe_index % size.x, safe_index / size.x);
}

vec4 fetch_wave(float source, out float known) {
  float point = clamp(source, 0.0, 1.0) * float(max(0, u_wave_count - 1));
  int left = int(floor(point));
  int right = min(u_wave_count - 1, left + 1);
  float mix_value = fract(point);
  float left_known = texelFetch(u_known, sample_coord(left, u_wave_size), 0).r;
  float right_known = texelFetch(u_known, sample_coord(right, u_wave_size), 0).r;
  vec4 left_value = texelFetch(u_wave, sample_coord(left, u_wave_size), 0);
  vec4 right_value = texelFetch(u_wave, sample_coord(right, u_wave_size), 0);
  known = max(left_known, right_known);
  if (left_known < 0.5) return right_value;
  if (right_known < 0.5) return left_value;
  return mix(left_value, right_value, mix_value);
}

// Reconstruct one output pixel from a small source-time footprint. Peak amplitude keeps short
// transients visible, while the weighted colour average avoids the old arg-max colour switching
// that made adjacent physical pixels sparkle as the rail moved.
vec4 fetch_filtered_wave(float source, float source_per_pixel, out float known) {
  vec3 colour_sum = vec3(0.0);
  float colour_weight = 0.0;
  float peak = -1.0;
  known = 0.0;
  for (int tap = -1; tap <= 1; tap += 1) {
    float tap_known = 0.0;
    vec4 value = fetch_wave(source + float(tap) * source_per_pixel * 0.8, tap_known);
    if (tap_known < 0.5) continue;
    float kernel = tap == 0 ? 0.5 : 0.25;
    float weight = kernel * (0.2 + value.a);
    colour_sum += value.rgb * weight;
    colour_weight += weight;
    peak = max(peak, value.a);
    known = 1.0;
  }
  return vec4(colour_sum / max(0.0001, colour_weight), max(0.0, peak));
}

vec4 fetch_placeholder(float source) {
  float point = clamp(source, 0.0, 1.0) * float(max(0, u_placeholder_count - 1));
  int left = int(floor(point));
  int right = min(u_placeholder_count - 1, left + 1);
  return mix(
    texelFetch(u_placeholder, sample_coord(left, u_placeholder_size), 0),
    texelFetch(u_placeholder, sample_coord(right, u_placeholder_size), 0),
    fract(point)
  );
}

void main() {
  if (u_duration <= 0.0 || u_wave_count <= 0) discard;
  float source_time = u_position + (v_uv.x - 0.5) * u_view_seconds;
  float source_per_pixel = u_view_seconds / max(1.0, u_duration * u_output_width);
  float available_half = max(0.5 / u_output_height, 0.5 - min(0.45, max(0.0, u_inset)));
  vec3 colour_sum = vec3(0.0);
  float alpha_sum = 0.0;

  // Three shutter samples turn a 2-4 physical-pixel 60 Hz jump into continuous coverage without
  // delaying the authoritative position. u_motion_seconds is capped on the CPU and is zero for
  // seeks, loop wraps, scratches and the first frame after a pause.
  for (int exposure = 0; exposure < 3; exposure += 1) {
    float exposure_mix = float(exposure) * 0.5;
    float exposure_weight = exposure == 0 ? 0.58 : (exposure == 1 ? 0.27 : 0.15);
    float sample_time = source_time - u_motion_seconds * exposure_mix;
    if (sample_time < 0.0 || sample_time > u_duration) continue;
    float source = sample_time / u_duration;
    float selected_known = 0.0;
    vec4 selected = fetch_filtered_wave(source, source_per_pixel, selected_known);
    float sample_opacity = u_opacity;
    if (selected_known < 0.5) {
      if (!u_has_placeholder || u_placeholder_count <= 0) continue;
      selected = fetch_placeholder(source);
      if (selected.a <= 0.01) continue;
      sample_opacity *= 0.3;
    } else if (u_silence > 0.0 && selected.a <= u_silence) {
      continue;
    }

    float half_height = max(0.5 / u_output_height, selected.a * available_half);
    // Analytic physical-pixel coverage replaces the hard discard at the waveform silhouette.
    // The old edge could only gain/lose a whole device pixel and looked like it was climbing a
    // staircase even though u_position itself already advanced at requestAnimationFrame cadence.
    float coverage = clamp(
      (half_height - abs(v_uv.y - 0.5)) * u_output_height + 0.5,
      0.0,
      1.0
    );
    float alpha = sample_opacity * coverage * exposure_weight;
    colour_sum += selected.rgb * alpha;
    alpha_sum += alpha;
  }

  if (alpha_sum <= 0.0001) discard;
  out_color = vec4(colour_sum / alpha_sum, alpha_sum);
}`;

const PERFORMANCE_WAVEFORM_SHUTTER_RATIO = 0.75;
const PERFORMANCE_WAVEFORM_MAX_TRAIL_PHYSICAL_PIXELS = 4;
const PERFORMANCE_WAVEFORM_DISCONTINUITY_PHYSICAL_PIXELS = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * Preserve sub-CSS-pixel motion while making coverage stable in the physical-pixel rasterizer.
 * The previous `Math.round(x) + 0.5` moved a Retina line in whole CSS pixels (two physical pixels)
 * and produced an obvious 1/2/1/2-pixel cadence at ordinary playback speed.
 */
export function performanceOverlayStrokeX(cssX: number, devicePixelRatio: number): number {
  const x = Number.isFinite(cssX) ? cssX : 0;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.round(x * dpr * 4) / (dpr * 4);
}

/**
 * Convert consecutive display-clock positions into a short, bounded temporal exposure.
 *
 * Ordinary playback moves roughly 2 CSS pixels per 60 Hz frame. Keeping part of that distance as
 * a shutter trail removes sample-and-hold judder; large jumps are transport discontinuities and
 * deliberately get no trail so seeks, scratches and loop wraps still land exactly.
 */
export function performanceWaveformMotionSeconds(
  previousPosition: number | null,
  position: number,
  viewportSeconds: number,
  physicalWidth: number,
  enabled: boolean,
): number {
  if (
    !enabled
    || previousPosition === null
    || !Number.isFinite(previousPosition)
    || !Number.isFinite(position)
    || !Number.isFinite(viewportSeconds)
    || viewportSeconds <= 0
    || !Number.isFinite(physicalWidth)
    || physicalWidth <= 0
  ) return 0;
  const deltaSeconds = position - previousPosition;
  const deltaPixels = (deltaSeconds / viewportSeconds) * physicalWidth;
  if (Math.abs(deltaPixels) > PERFORMANCE_WAVEFORM_DISCONTINUITY_PHYSICAL_PIXELS) return 0;
  const trailPixels = clamp(
    deltaPixels * PERFORMANCE_WAVEFORM_SHUTTER_RATIO,
    -PERFORMANCE_WAVEFORM_MAX_TRAIL_PHYSICAL_PIXELS,
    PERFORMANCE_WAVEFORM_MAX_TRAIL_PHYSICAL_PIXELS,
  );
  return (trailPixels / physicalWidth) * viewportSeconds;
}

/** Pack arbitrarily long waveform columns into rows below the device texture-size limit. */
export function packPerformanceWaveformTexture(
  wave: Waveform,
  maxTextureWidth = 4_096,
): PackedPerformanceWaveformTexture {
  const count = Math.min(wave.amp.length, wave.r.length, wave.g.length, wave.b.length);
  const width = Math.max(1, Math.min(count || 1, Math.max(1, Math.floor(maxTextureWidth))));
  const height = Math.max(1, Math.ceil(Math.max(1, count) / width));
  const colorBytes = new Uint8Array(width * height * 4);
  const knownBytes = new Uint8Array(width * height);
  for (let index = 0; index < count; index += 1) {
    const colorAt = index * 4;
    const [red, green, blue] = waveformDisplayRgb(
      wave.r[index] ?? 0,
      wave.g[index] ?? 0,
      wave.b[index] ?? 0,
      wave.amp[index] ?? 0,
    );
    colorBytes[colorAt] = red;
    colorBytes[colorAt + 1] = green;
    colorBytes[colorAt + 2] = blue;
    colorBytes[colorAt + 3] = clamp(Math.round((wave.amp[index] ?? 0) * 255), 0, 255);
    knownBytes[index] = wave.known === undefined || wave.known[index] ? 255 : 0;
  }
  return { colorBytes, knownBytes, width, height, count };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建波形 GPU shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "未知 shader 编译错误";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("无法创建波形 GPU program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "未知 program 链接错误";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

const UNIFORM_LOCATIONS = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation>>();

function requiredUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  let programLocations = UNIFORM_LOCATIONS.get(program);
  if (!programLocations) {
    programLocations = new Map();
    UNIFORM_LOCATIONS.set(program, programLocations);
  }
  const cached = programLocations.get(name);
  if (cached) return cached;
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`波形 GPU uniform 缺失：${name}`);
  programLocations.set(name, location);
  return location;
}

/**
 * One renderer owns all visible waveform lanes and the grid for a physical Deck. React publishes
 * sparse transport/data snapshots; requestAnimationFrame calls draw with the display-rate clock.
 */
export class PerformanceWaveformRenderer {
  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlay: CanvasRenderingContext2D;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private textures = new Map<Waveform, WaveTexture>();
  private model: PerformanceWaveRenderModel | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private dirty = true;
  private previousDrawPosition: number | null = null;
  private previousTemporalSmoothing = false;
  private readonly onContextLost: (event: Event) => void;
  private readonly onContextRestored: () => void;

  constructor(glCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement) {
    this.glCanvas = glCanvas;
    this.overlayCanvas = overlayCanvas;
    const overlay = overlayCanvas.getContext("2d");
    if (!overlay) throw new Error("无法创建波形叠加画布");
    this.overlay = overlay;
    this.onContextLost = (event) => {
      event.preventDefault();
      this.gl = null;
      this.program = null;
      this.vertexBuffer = null;
      this.textures.clear();
      this.glCanvas.hidden = true;
      this.dirty = true;
      this.previousDrawPosition = null;
      this.previousTemporalSmoothing = false;
    };
    this.onContextRestored = () => this.initializeGl();
    glCanvas.addEventListener("webglcontextlost", this.onContextLost);
    glCanvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.initializeGl();
  }

  private initializeGl(): void {
    try {
      const gl = this.glCanvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        desynchronized: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      });
      if (!gl) return;
      const program = createProgram(gl);
      const vertexBuffer = gl.createBuffer();
      if (!vertexBuffer) throw new Error("无法创建波形 GPU vertex buffer");
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      this.gl = gl;
      this.program = program;
      this.vertexBuffer = vertexBuffer;
      this.textures.clear();
      this.glCanvas.hidden = false;
      this.dirty = true;
      this.previousDrawPosition = null;
      this.previousTemporalSmoothing = false;
      if (this.model) this.syncTextures();
    } catch {
      // WebGL2 is an acceleration path, never a playback requirement. The 2D viewport fallback
      // below stays operational on old/blocked WebViews and after driver initialization failure.
      this.gl = null;
      this.program = null;
      this.vertexBuffer = null;
      this.glCanvas.hidden = true;
    }
  }

  setModel(model: PerformanceWaveRenderModel): void {
    this.model = model;
    this.dirty = true;
    if (this.gl) this.syncTextures();
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = Math.max(0, cssWidth);
    this.cssHeight = Math.max(0, cssHeight);
    this.dpr = clamp(devicePixelRatio, 1, 3);
    const width = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const height = Math.max(1, Math.round(this.cssHeight * this.dpr));
    const changed = this.glCanvas.width !== width
      || this.glCanvas.height !== height
      || this.overlayCanvas.width !== width
      || this.overlayCanvas.height !== height;
    if (this.glCanvas.width !== width) this.glCanvas.width = width;
    if (this.glCanvas.height !== height) this.glCanvas.height = height;
    if (this.overlayCanvas.width !== width) this.overlayCanvas.width = width;
    if (this.overlayCanvas.height !== height) this.overlayCanvas.height = height;
    if (changed) {
      this.dirty = true;
      this.previousDrawPosition = null;
      this.previousTemporalSmoothing = false;
    }
  }

  /** Paused/empty Decks stay subscribed to the shared frame clock but do no canvas work. */
  needsDraw(): boolean {
    return this.dirty;
  }

  invalidate(): void {
    this.dirty = true;
  }

  private syncTextures(): void {
    const gl = this.gl;
    const model = this.model;
    if (!gl || !model) return;
    const desired = new Set<Waveform>();
    for (const lane of model.lanes) {
      if (lane.waveform) desired.add(lane.waveform);
      if (lane.placeholder) desired.add(lane.placeholder);
    }
    for (const wave of desired) {
      if (!this.textures.has(wave)) this.textures.set(wave, this.uploadWave(wave));
    }
    for (const [wave, texture] of this.textures) {
      if (desired.has(wave)) continue;
      gl.deleteTexture(texture.color);
      gl.deleteTexture(texture.known);
      this.textures.delete(wave);
    }
  }

  private uploadWave(wave: Waveform): WaveTexture {
    const gl = this.gl;
    if (!gl) throw new Error("波形 GPU 上下文不可用");
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const { colorBytes, knownBytes, width, height, count } = packPerformanceWaveformTexture(
      wave,
      Math.min(maxTextureSize, 4_096),
    );
    const color = gl.createTexture();
    const known = gl.createTexture();
    if (!color || !known) throw new Error("无法创建波形 GPU texture");
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorBytes);
    gl.bindTexture(gl.TEXTURE_2D, known);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, knownBytes);
    return { color, known, width, height, count };
  }

  draw(position: number, temporalSmoothing = false): void {
    const model = this.model;
    if (!model || this.cssWidth <= 0 || this.cssHeight <= 0) return;
    const motionSeconds = performanceWaveformMotionSeconds(
      this.previousDrawPosition,
      position,
      model.viewportSeconds,
      this.glCanvas.width,
      temporalSmoothing && this.previousTemporalSmoothing,
    );
    if (this.gl && this.program) {
      try {
        this.drawGpu(position, motionSeconds, model);
      } catch (error) {
        console.error("Performance WebGL2 波形失效，切换到 Canvas 2D", error);
        this.gl = null;
        this.program = null;
        this.vertexBuffer = null;
        this.textures.clear();
        this.glCanvas.hidden = true;
      }
    }
    this.drawOverlay(position, motionSeconds, model, !this.gl || !this.program);
    this.previousDrawPosition = position;
    this.previousTemporalSmoothing = temporalSmoothing;
    this.dirty = false;
  }

  private drawGpu(
    position: number,
    motionSeconds: number,
    model: PerformanceWaveRenderModel,
  ): void {
    const gl = this.gl;
    const program = this.program;
    if (!gl || !program) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.useProgram(program);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(requiredUniform(gl, program, "u_wave"), 0);
    gl.uniform1i(requiredUniform(gl, program, "u_known"), 1);
    gl.uniform1i(requiredUniform(gl, program, "u_placeholder"), 2);
    gl.uniform1f(requiredUniform(gl, program, "u_position"), position);
    gl.uniform1f(requiredUniform(gl, program, "u_duration"), model.duration);
    gl.uniform1f(requiredUniform(gl, program, "u_view_seconds"), model.viewportSeconds);
    gl.uniform1f(requiredUniform(gl, program, "u_motion_seconds"), motionSeconds);

    for (const lane of model.lanes) {
      if (!lane.waveform || lane.height <= 0) continue;
      const wave = this.textures.get(lane.waveform);
      if (!wave || wave.count <= 0) continue;
      const placeholder = lane.placeholder ? this.textures.get(lane.placeholder) : null;
      const physicalTop = Math.round(lane.top * this.dpr);
      const physicalHeight = Math.max(1, Math.round(lane.height * this.dpr));
      const viewportY = this.glCanvas.height - physicalTop - physicalHeight;
      gl.viewport(0, viewportY, this.glCanvas.width, physicalHeight);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, wave.color);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, wave.known);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, placeholder?.color ?? wave.color);
      gl.uniform2i(requiredUniform(gl, program, "u_wave_size"), wave.width, wave.height);
      gl.uniform2i(
        requiredUniform(gl, program, "u_placeholder_size"),
        placeholder?.width ?? wave.width,
        placeholder?.height ?? wave.height,
      );
      gl.uniform1i(requiredUniform(gl, program, "u_wave_count"), wave.count);
      gl.uniform1i(requiredUniform(gl, program, "u_placeholder_count"), placeholder?.count ?? 0);
      gl.uniform1f(requiredUniform(gl, program, "u_output_width"), this.glCanvas.width);
      gl.uniform1f(requiredUniform(gl, program, "u_output_height"), physicalHeight);
      gl.uniform1f(requiredUniform(gl, program, "u_inset"), lane.verticalInsetRatio ?? 0.1);
      gl.uniform1f(requiredUniform(gl, program, "u_silence"), lane.silenceThreshold ?? 0);
      gl.uniform1f(requiredUniform(gl, program, "u_opacity"), lane.opacity ?? 1);
      gl.uniform1i(requiredUniform(gl, program, "u_has_placeholder"), placeholder ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  private drawOverlay(
    position: number,
    motionSeconds: number,
    model: PerformanceWaveRenderModel,
    fallback: boolean,
  ): void {
    const ctx = this.overlay;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (fallback) this.drawFallbackWaves(ctx, position, model);
    const width = this.cssWidth;
    const height = this.cssHeight;
    const view = Math.max(0.001, model.viewportSeconds);
    const start = position - view / 2;
    const timeX = (time: number) => ((time - start) / view) * width;
    // Earlier shutter samples sit to the right during normal forward playback. Keep overlays on
    // the same exposure as the GPU waveform so the grid never appears to judder independently.
    const motionCssPixels = (motionSeconds / view) * width;
    const motionPasses = Math.abs(motionCssPixels) >= 0.125
      ? [
          { offset: motionCssPixels, alpha: 0.15 },
          { offset: motionCssPixels * 0.5, alpha: 0.27 },
          { offset: 0, alpha: 0.58 },
        ]
      : [{ offset: 0, alpha: 1 }];

    for (const region of waveformLoopRegions(model.cuePoints, model.loopStart, model.loopLength)) {
      const left = timeX(region.startSec);
      const right = timeX(region.endSec);
      if (right <= 0 || left >= width) continue;
      ctx.save();
      ctx.globalAlpha = region.active ? 0.22 : 0.12;
      ctx.fillStyle = region.color;
      ctx.fillRect(Math.max(0, left), 0, Math.min(width, right) - Math.max(0, left), height);
      ctx.restore();
    }

    const bpm = model.bpm;
    const firstBeat = model.firstBeat;
    if (
      bpm !== null
      && Number.isFinite(bpm)
      && bpm > 0
      && firstBeat !== null
      && Number.isFinite(firstBeat)
      && (model.bpmConfidence === null || model.bpmConfidence >= 0.45)
    ) {
      const interval = 60 / bpm;
      const barSeconds = interval * 4;
      let origin = firstBeat % barSeconds;
      if (origin < 0) origin += barSeconds;
      const firstIndex = Math.max(0, Math.ceil((Math.max(0, start) - origin) / interval - 1e-9));
      const lastIndex = Math.max(-1, Math.floor((Math.min(model.duration, start + view) - origin) / interval + 1e-9));
      ctx.font = "800 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "top";
      const minorLines: number[] = [];
      const barLines: Array<{ x: number; label: string }> = [];
      for (let index = firstIndex; index <= lastIndex && index - firstIndex < 512; index += 1) {
        const x = timeX(origin + index * interval);
        if (index % 4 === 0) {
          barLines.push({ x, label: String(Math.floor(index / 4) + 1) });
        } else {
          minorLines.push(x);
        }
      }
      // Batch each line class into one path per shutter pass. The former per-beat begin/stroke
      // loop forced dozens of Canvas2D submissions on every frame of both Decks.
      const strokeLines = (lines: readonly number[], colour: string, lineWidth: number) => {
        if (lines.length === 0) return;
        for (const pass of motionPasses) {
          ctx.save();
          ctx.globalAlpha = pass.alpha;
          ctx.strokeStyle = colour;
          ctx.lineWidth = lineWidth;
          ctx.beginPath();
          for (const lineX of lines) {
            const x = performanceOverlayStrokeX(lineX + pass.offset, this.dpr);
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
          }
          ctx.stroke();
          ctx.restore();
        }
      };
      strokeLines(minorLines, "rgba(210,218,228,0.26)", 1);
      strokeLines(barLines.map((line) => line.x), "#e8c126", 1);
      ctx.fillStyle = "#ffe56a";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 2;
      for (const line of barLines) {
        const x = performanceOverlayStrokeX(line.x, this.dpr);
        ctx.fillText(line.label, x + 4, 2);
      }
      ctx.shadowBlur = 0;
    }

    const drawCue = (time: number, color: string) => {
      const rawX = timeX(time);
      const x = performanceOverlayStrokeX(rawX, this.dpr);
      if (x < -8 || x > width + 8) return;
      for (const pass of motionPasses) {
        const strokeX = performanceOverlayStrokeX(rawX + pass.offset, this.dpr);
        ctx.save();
        ctx.globalAlpha = pass.alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(strokeX, 0);
        ctx.lineTo(strokeX, height);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 6, 0);
      ctx.lineTo(x + 6, 0);
      ctx.lineTo(x, 8);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 6, height);
      ctx.lineTo(x + 6, height);
      ctx.lineTo(x, height - 8);
      ctx.closePath();
      ctx.fill();
    };
    for (const cue of model.cuePoints) {
      drawCue(cue.start_ms / 1_000, cueColor(cue));
      if (cue.end_ms !== null) drawCue(cue.end_ms / 1_000, cueColor(cue));
    }
    if (model.cueMs !== null) drawCue(model.cueMs / 1_000, "#7d8796");
    if (model.endMs !== null) drawCue(model.endMs / 1_000, "#7d8796");

    const center = width / 2;
    for (const lane of model.lanes) {
      if (!lane.waveform) continue;
      ctx.save();
      ctx.strokeStyle = lane.key === "org" ? "#ff344f" : "rgba(255,255,255,0.94)";
      ctx.lineWidth = lane.key === "org" ? 2 : 1;
      ctx.shadowColor = lane.key === "org" ? "rgba(255,52,79,0.75)" : "#000";
      ctx.shadowBlur = lane.key === "org" ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(center, lane.top);
      ctx.lineTo(center, lane.top + lane.height);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawFallbackWaves(
    ctx: CanvasRenderingContext2D,
    position: number,
    model: PerformanceWaveRenderModel,
  ): void {
    const width = Math.max(1, Math.floor(this.cssWidth));
    const view = Math.max(0.001, model.viewportSeconds);
    for (const lane of model.lanes) {
      const wave = lane.waveform;
      if (!wave || wave.amp.length === 0 || lane.height <= 0) continue;
      const duration = model.duration > 0 ? model.duration : wave.duration;
      const middle = lane.top + lane.height / 2;
      const availableHalf = Math.max(0.5, lane.height * (0.5 - clamp(lane.verticalInsetRatio ?? 0.1, 0, 0.45)));
      ctx.globalAlpha = lane.opacity ?? 1;
      for (let x = 0; x < width; x += 1) {
        const time = position + ((x + 0.5) / width - 0.5) * view;
        if (time < 0 || time > duration) continue;
        const index = Math.min(wave.amp.length - 1, Math.max(0, Math.round((time / duration) * (wave.amp.length - 1))));
        const known = wave.known === undefined || Boolean(wave.known[index]);
        const source = known ? wave : lane.placeholder;
        if (!source || source.amp.length === 0) continue;
        const sourceIndex = known
          ? index
          : Math.min(source.amp.length - 1, Math.max(0, Math.round((time / duration) * (source.amp.length - 1))));
        const amp = clamp(source.amp[sourceIndex] ?? 0, 0, 1);
        if ((known && (lane.silenceThreshold ?? 0) > 0 && amp <= (lane.silenceThreshold ?? 0)) || amp <= 0.01) continue;
        ctx.globalAlpha = (lane.opacity ?? 1) * (known ? 1 : 0.3);
        const [red, green, blue] = waveformDisplayRgb(
          source.r[sourceIndex] ?? 0,
          source.g[sourceIndex] ?? 0,
          source.b[sourceIndex] ?? 0,
          amp,
        );
        ctx.fillStyle = `rgb(${red},${green},${blue})`;
        const half = Math.max(0.5, amp * availableHalf);
        ctx.fillRect(x, middle - half, 1, half * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  destroy(): void {
    this.glCanvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.glCanvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const gl = this.gl;
    if (gl) {
      for (const texture of this.textures.values()) {
        gl.deleteTexture(texture.color);
        gl.deleteTexture(texture.known);
      }
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.textures.clear();
    this.gl = null;
    this.program = null;
    this.vertexBuffer = null;
    this.dirty = false;
    this.previousDrawPosition = null;
    this.previousTemporalSmoothing = false;
  }
}
