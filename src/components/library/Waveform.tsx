import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { Waveform as WaveformData } from "../../types";

/** 点波形跳转：PlayerBar 监听它，和 kd:play / kd:position 一套约定。 */
export const SEEK_EVENT = "kd:seek";
export interface SeekDetail {
  trackId: number;
  position: number;
}

/**
 * Serato / Rekordbox 那种彩色波形。
 *
 * 模型来自 libdjwaveform：**一列 = 一根柱子**，高度是这一列的响度，
 * 颜色是这一列的频谱构成（红=低频鼓组、绿=中频人声、蓝=高频镲片）。
 * 后端 `/api/library/waveform` 已经把每列的 amp + rgb 算好，这里只负责画。
 *
 * 用 canvas 而不是 SVG：几百到上千根柱子如果各是一个 <rect>，
 * 光是 DOM 节点就够让曲库切曲卡一下；canvas 一次 fillRect 循环画完。
 */
export interface WaveformProps {
  trackId: number;
  /** 播放位置（秒）。传 null 就不画播放头。 */
  position?: number | null;
  height?: number;
  /** 已播部分压暗，凸显未播部分（底部进度条用）。 */
  dimPlayed?: boolean;
  /** 点击是否跳转。 */
  seekable?: boolean;
  className?: string;
}

/** 同一首歌可能同时被详情栏和播放条要走，用内存缓存挡掉重复请求。 */
const cache = new Map<number, WaveformData>();
const inflight = new Map<number, Promise<WaveformData>>();

function loadWaveform(trackId: number): Promise<WaveformData> {
  const hit = cache.get(trackId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(trackId);
  if (pending) return pending;
  const request = api
    .waveform(trackId)
    .then((data) => {
      cache.set(trackId, data);
      inflight.delete(trackId);
      return data;
    })
    .catch((error: unknown) => {
      inflight.delete(trackId);
      throw error;
    });
  inflight.set(trackId, request);
  return request;
}

function draw(canvas: HTMLCanvasElement, wave: WaveformData, cssWidth: number, cssHeight: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const n = wave.amp.length;
  if (n === 0) return;
  const mid = cssHeight / 2;
  const width = Math.max(1, Math.floor(cssWidth));

  // 按**像素列**遍历而不是按数据列：数据比像素多时取区间最大值（不会漏掉瞬态），
  // 少时同一根柱子铺满几个像素。两种缩放都不会出现摩尔纹或空隙。
  for (let x = 0; x < width; x += 1) {
    const from = Math.floor((x * n) / width);
    const to = Math.max(from + 1, Math.floor(((x + 1) * n) / width));
    let amp = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = from; i < to && i < n; i += 1) {
      const value = wave.amp[i];
      if (value > amp) amp = value;
      // 颜色按幅度加权平均：安静帧的颜色本来就不可靠，不该和强拍平起平坐
      const w = value + 0.001;
      r += wave.r[i] * w;
      g += wave.g[i] * w;
      b += wave.b[i] * w;
      weight += w;
    }
    if (weight <= 0) continue;
    ctx.fillStyle = `rgb(${Math.round(r / weight)},${Math.round(g / weight)},${Math.round(b / weight)})`;
    // 最小 1px：静音段也留一条中线，否则波形会断成几截看着像坏了
    const half = Math.max(0.5, amp * (mid - 1));
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
}

export function Waveform({
  trackId,
  position = null,
  height = 56,
  dimPlayed = false,
  seekable = true,
  className,
}: WaveformProps) {
  const [wave, setWave] = useState<WaveformData | null>(() => cache.get(trackId) ?? null);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let alive = true;
    const cached = cache.get(trackId);
    setWave(cached ?? null);
    setError("");
    if (cached) return;
    loadWaveform(trackId)
      .then((result) => {
        if (alive) setWave(result);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    // 切曲目时作废上一条请求，慢响应不会画到新曲子上
    return () => {
      alive = false;
    };
  }, [trackId]);

  // 只在数据/尺寸变化时重画。播放头和已播遮罩都是 DOM 层，
  // 位置每 200ms 变一次也不会触发 canvas 重绘。
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || !wave) return;
    const render = () => draw(canvas, wave, host.clientWidth, height);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    return () => observer.disconnect();
  }, [wave, height]);

  const total = wave?.duration ?? 0;
  const ratio = total > 0 && position !== null ? Math.min(1, Math.max(0, position / total)) : null;
  const ready = wave !== null && wave.amp.length > 0;

  return (
    <div
      ref={hostRef}
      className={className}
      style={{
        position: "relative",
        height,
        background: "var(--kd-panel-inset)",
        cursor: seekable && total > 0 ? "pointer" : "default",
        // 播放头需要越过波形上下边界，像 DAW/AU 的时间游标；canvas 本身不会溢出。
        overflow: "visible",
      }}
      onClick={
        seekable
          ? (event) => {
              if (total <= 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const at = ((event.clientX - rect.left) / rect.width) * total;
              window.dispatchEvent(
                new CustomEvent<SeekDetail>(SEEK_EVENT, { detail: { trackId, position: at } }),
              );
            }
          : undefined
      }
      title={seekable && total > 0 ? "点击跳转" : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{ display: ready ? "block" : "none", width: "100%", height }}
        role="img"
        aria-label="频谱波形"
      />
      {!ready && (
        <div
          className="kd-muted"
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "var(--kd-size-xs)",
          }}
        >
          {error ? `波形不可用：${error}` : "正在生成波形…"}
        </div>
      )}

      {/* 已播部分压暗：不换色，只盖一层半透明遮罩，颜色信息还在。
          遮罩色跟主题走：深色主题盖黑、浅色主题盖白，白天才不会糊成一团黑 */}
      {dimPlayed && ratio !== null && ratio > 0 && (
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${ratio * 100}%`,
            background: "var(--kd-wave-dim, rgba(0,0,0,0.55))",
            pointerEvents: "none",
          }}
        />
      )}

      {ratio !== null && (
        <span
          className="kd-wave-playhead"
          style={{
            position: "absolute",
            left: `${ratio * 100}%`,
            width: 1,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
