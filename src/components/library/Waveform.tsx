import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  cachedWaveform,
  loadWaveformForTrack,
  loadWaveformById,
  streamWaveformSnapshot,
  subscribeStreamWaveform,
  updateStreamWaveform,
  type StreamWaveformSnapshot,
} from "../../lib/waveformCache";
import type { CuePoint, Track, Waveform as WaveformData } from "../../types";
import { cueColor, cueTextColor, cueTitle, hotCueLabel } from "../../lib/cuePoints";
import { isOneLibraryPlaybackTrack } from "../../lib/playbackTrackSource";
import { waveformEdgeScales } from "../../lib/waveformRenderPolicy";
import { waveformScrubPosition } from "../../lib/waveformScrub";
import { ContextMenu } from "../common";

/** 点波形跳转：PlayerBar 监听它，和 kd:play / kd:position 一套约定。 */
export const SEEK_EVENT = "kd:seek";
export interface SeekDetail {
  trackId: number;
  position: number;
  /** 拖动中的视觉预览不启动解码；松手或键盘操作时才真正跳转。 */
  preview?: boolean;
  /**
   * scrub 手势边界：pointerdown 发 true，pointerup（随正式跳转）/pointercancel
   * 发 false。拖动期间 PlayerBar 压制权威时钟，不把播放头从手底下顶回去。
   */
  scrubbing?: boolean;
  /** 同一次手势的最终落点不能被媒体同步回声去重吞掉。 */
  forceCommit?: boolean;
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
  /** 负数 id 不再等同于在线试听；OneLibrary 需要这份来源快照加载外置文件波形。 */
  track?: Track | null;
  /** 播放位置（秒）。传 null 就不画播放头。 */
  position?: number | null;
  /** 波形尚未返回时用于进度条跳转的媒体时长（秒）。 */
  duration?: number;
  /** 开始点（毫秒）。有值时顶部画主题色小三角。 */
  cueMs?: number | null;
  /** 结束点（毫秒）。有值时顶部画主题色小三角。 */
  endMs?: number | null;
  /** DJ 软件写入的标准 Cue / Loop；仅展示，不参与现有起止点操作。 */
  cuePoints?: readonly CuePoint[];
  /**
   * 右键设起止点。返回错误文案则菜单旁提示；返回 void/空串表示成功。
   * 不传则不挂右键菜单。
   */
  onSetPoint?: (kind: "start" | "end", positionSec: number) => void | string | Promise<void | string>;
  height?: number;
  /** 已播部分压暗，凸显未播部分（底部进度条用）。 */
  dimPlayed?: boolean;
  /** 点击是否跳转。 */
  seekable?: boolean;
  className?: string;
}

function draw(
  canvas: HTMLCanvasElement,
  wave: WaveformData,
  cssWidth: number,
  cssHeight: number,
  known?: readonly boolean[],
) {
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

  interface PixelColumn {
    amp: number;
    r: number;
    g: number;
    b: number;
    known: boolean;
  }
  const columns: PixelColumn[] = [];
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
    let hasKnownSample = known === undefined;
    for (let i = from; i < to && i < n; i += 1) {
      if (known && !known[i]) continue;
      hasKnownSample = true;
      const value = wave.amp[i];
      if (value > amp) amp = value;
      // 颜色按幅度加权平均：安静帧的颜色本来就不可靠，不该和强拍平起平坐
      const w = value + 0.001;
      r += wave.r[i] * w;
      g += wave.g[i] * w;
      b += wave.b[i] * w;
      weight += w;
    }
    columns.push({
      amp,
      r: weight > 0 ? Math.round(r / weight) : 0,
      g: weight > 0 ? Math.round(g / weight) : 0,
      b: weight > 0 ? Math.round(b / weight) : 0,
      known: hasKnownSample && weight > 0,
    });
  }

  // 在线渐进波形的首/尾真实桶可能从静音基线一步跳到满高，视觉上会变成截图里
  // 那种整高竖墙。只给最外侧几列做屏幕空间包络；内部瞬态和 unknown 掩码不动。
  const edgeScales = known
    ? waveformEdgeScales(
        columns.map((column) => column.amp),
        columns.map((column) => column.known),
      )
    : null;
  for (let x = 0; x < columns.length; x += 1) {
    const column = columns[x];
    if (!column.known) {
      // 未采样部分由 DOM 下层的流媒体渐变轨道表达，不拿灰柱或随机柱冒充波形。
      continue;
    }
    ctx.fillStyle = `rgb(${column.r},${column.g},${column.b})`;
    // 最小 1px：静音段也留一条中线，否则波形会断成几截看着像坏了
    const half = Math.max(0.5, column.amp * (edgeScales?.[x] ?? 1) * (mid - 1));
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
}

function markerRatio(ms: number | null | undefined, totalSec: number): number | null {
  if (ms == null || totalSec <= 0) return null;
  return Math.min(1, Math.max(0, ms / 1000 / totalSec));
}

/** 校验起止点并生成 patch；不合法返回中文原因。 */
export function pointPatch(
  kind: "start" | "end",
  positionSec: number,
  cueMs: number | null | undefined,
  endMs: number | null | undefined,
): { cue_ms: number } | { end_ms: number } | string {
  const ms = Math.max(0, Math.round(positionSec * 1000));
  if (kind === "start") {
    if (endMs != null && ms >= endMs) return "开始点必须早于结束点";
    return { cue_ms: ms };
  }
  if (cueMs != null && ms <= cueMs) return "结束点必须晚于开始点";
  return { end_ms: ms };
}

export function Waveform({
  trackId,
  track = null,
  position = null,
  duration = 0,
  cueMs = null,
  endMs = null,
  cuePoints = [],
  onSetPoint,
  height = 56,
  dimPlayed = false,
  seekable = true,
  className,
}: WaveformProps) {
  const oneLibraryTrack =
    track?.id === trackId && isOneLibraryPlaybackTrack(track) ? track : null;
  const progressiveStream = trackId < 0 && oneLibraryTrack === null;
  const [wave, setWave] = useState<WaveformData | null>(() => cachedWaveform(trackId));
  const [streamSnapshot, setStreamSnapshot] = useState<StreamWaveformSnapshot | null>(() =>
    progressiveStream ? streamWaveformSnapshot(trackId) : null,
  );
  const [error, setError] = useState("");
  // 右键设点永远取当时正在播放的位置，不能让鼠标点到波形哪里就误落到哪里。
  const [menu, setMenu] = useState<{ x: number; y: number; position: number } | null>(null);
  const [menuError, setMenuError] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);
  const previewPositionRef = useRef(0);

  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    },
    [],
  );

  const dispatchSeek = (
    nextPosition: number,
    preview = false,
    scrubbing?: boolean,
    forceCommit = false,
  ) => {
    window.dispatchEvent(
      new CustomEvent<SeekDetail>(SEEK_EVENT, {
        detail: { trackId, position: nextPosition, preview, scrubbing, forceCommit },
      }),
    );
  };

  const trackIdRef = useRef(trackId);
  useEffect(() => {
    trackIdRef.current = trackId;
  }, [trackId]);

  // 拖动中组件被卸载（切歌/切试听流）也必须松开 PlayerBar 的 scrub 标记，
  // 否则权威时钟被永久压制、播放头冻结。卸载时 trackId 可能已换，走 ref。
  useEffect(
    () => () => {
      if (draggingRef.current) {
        window.dispatchEvent(
          new CustomEvent<SeekDetail>(SEEK_EVENT, {
            detail: {
              trackId: trackIdRef.current,
              position: previewPositionRef.current,
              preview: true,
              scrubbing: false,
            },
          }),
        );
      }
    },
    [],
  );

  // 原生 range 在指针下自己移动；播放头预览最多每帧同步一次。整个指针手势只在
  // pointerup 提交最终落点，避免第一次 input 先启动原生 seek 后，受控 value 和
  // WebKit 的原生滑块跟踪争抢同一根拇指，表现成“按得下但拖不动”。
  const previewSeek = (nextPosition: number) => {
    previewPositionRef.current = nextPosition;
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      dispatchSeek(previewPositionRef.current, true);
    });
  };

  const pointerPosition = (input: HTMLInputElement, clientX: number) => {
    const rect = input.getBoundingClientRect();
    return waveformScrubPosition(clientX, rect.left, rect.width, total);
  };

  useEffect(() => {
    if (progressiveStream) {
      // 在线曲的波形只由当前媒体的 buffered + analyser 渐进生成，不能从这里另拉整首。
      setWave(null);
      setError("");
      return;
    }
    let alive = true;
    const cached = cachedWaveform(trackId);
    setWave(cached);
    setError("");
    if (cached) return;
    (oneLibraryTrack ? loadWaveformForTrack(oneLibraryTrack) : loadWaveformById(trackId))
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
  }, [trackId, oneLibraryTrack?.source_key, progressiveStream]);

  useEffect(() => {
    if (!progressiveStream) {
      setStreamSnapshot(null);
      return;
    }
    const sync = () => setStreamSnapshot(streamWaveformSnapshot(trackId));
    const unsubscribe = subscribeStreamWaveform(trackId, sync);
    // 首帧也建固定桶：即使媒体还没触发 progress，底栏仍有“未缓存”基线。
    if (!streamWaveformSnapshot(trackId)) {
      updateStreamWaveform(trackId, 0, duration, null, []);
    }
    sync();
    return unsubscribe;
  }, [trackId, progressiveStream]);

  useEffect(() => {
    if (progressiveStream && duration > 0) {
      // loadedmetadata 可能晚于首帧；只补时长，不清掉 PlayerBar 已喂入的缓存区间。
      updateStreamWaveform(trackId, 0, duration, null);
    }
  }, [trackId, duration, progressiveStream]);

  const activeStreamSnapshot =
    streamSnapshot?.waveform.track_id === trackId ? streamSnapshot : null;
  const displayWave = progressiveStream ? activeStreamSnapshot?.waveform ?? null : wave;

  // 只在数据/尺寸变化时重画。播放头和已播遮罩都是 DOM 层，
  // 位置每 200ms 变一次也不会触发 canvas 重绘。
  // clientWidth===0 时跳过：flex 首帧常为 0，硬画会留下空白 canvas，
  // 等 ResizeObserver 给出真实宽度再画。
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || !displayWave) return;
    const render = () => {
      const width = host.clientWidth;
      if (width <= 0) return;
      draw(
        canvas,
        displayWave,
        width,
        height,
        activeStreamSnapshot?.known,
      );
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    return () => observer.disconnect();
  }, [displayWave, activeStreamSnapshot, height]);

  // 波形计算可能要几秒；期间直接使用曲库/媒体元数据里的时长，让用户可以立刻拖动跳转。
  const waveDuration = displayWave?.duration ?? 0;
  const total = waveDuration > 0 ? waveDuration : duration;
  const ratio = total > 0 && position !== null ? Math.min(1, Math.max(0, position / total)) : null;
  const cueRatio = markerRatio(cueMs, total);
  const endRatio = markerRatio(endMs, total);
  const visibleCuePoints = total > 0
    ? cuePoints.filter((cue) => cue.start_ms >= 0 && cue.start_ms <= total * 1_000)
    : [];
  const ready = displayWave !== null && displayWave.amp.length > 0;

  const applyPoint = async (kind: "start" | "end") => {
    if (!menu || !onSetPoint) return;
    setMenuError("");
    try {
      const result = await onSetPoint(kind, menu.position);
      if (typeof result === "string" && result) {
        setMenuError(result);
        return;
      }
      setMenu(null);
    } catch (reason: unknown) {
      setMenuError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div
      ref={hostRef}
      className={className}
      style={{
        position: "relative",
        height,
        background: progressiveStream ? "transparent" : "var(--kd-panel-inset)",
        cursor: seekable && total > 0 ? "pointer" : "default",
        overflow: "hidden",
      }}
      // 滑轨是原生控件，由 WKWebView 自己完成屏幕坐标 → 进度换算；不用 div/canvas
      // click 的 clientX，在 Retina 缩放或底栏重排后不会把按下错投给曲目表。
      onPointerDownCapture={(event) => event.stopPropagation()}
      onContextMenu={
        onSetPoint
          ? (event) => {
              event.preventDefault();
              // 没有播放头（例如详情里看的不是正在播放的歌）就不猜一个位置。
              // 用户明确要的是“当前播放位置”，不是右键落点。
              if (position === null || total <= 0) return;
              setMenuError("");
              setMenu({ x: event.clientX, y: event.clientY, position });
            }
          : undefined
      }
      title={
        onSetPoint
          ? position !== null
            ? "点击跳转；右键在当前播放位置设开始/结束点"
            : "点击跳转；播放时可右键设开始/结束点"
          : seekable && total > 0
            ? "点击跳转"
            : undefined
      }
    >
      {progressiveStream && (
        <span className="kd-wave-stream-bed" aria-hidden="true">
          {(activeStreamSnapshot?.bufferedRanges ?? []).map((range, index) => {
            if (total <= 0) return null;
            const left = clampRatio(range.start / total) * 100;
            const right = clampRatio(range.end / total) * 100;
            return (
              <i
                key={`${index}:${range.start}:${range.end}`}
                style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
              />
            );
          })}
        </span>
      )}
      <canvas
        ref={canvasRef}
        style={{
          display: ready ? "block" : "none",
          position: "relative",
          zIndex: 1,
          width: "100%",
          height,
        }}
        role="img"
        aria-label="频谱波形"
      />
      {/* 在线流即使还没有第一帧 analyser 数据，也始终显示上面的渐变缓存轨；
          不能让通用的灰色 fallback 在首帧或媒体等待期间盖住它。 */}
      {!ready && !progressiveStream && (
        <div
          className="kd-wave-fallback"
          aria-hidden="true"
          title={error ? `波形不可用：${error}` : undefined}
        >
          <span
            className="kd-wave-fallback-fill"
            data-error={error ? "true" : undefined}
            style={{ width: `${ratio !== null ? ratio * 100 : 0}%` }}
          />
        </div>
      )}

      {/* 已播部分压暗：不换色，只盖一层半透明遮罩，颜色信息还在。
          遮罩色跟主题走：深色主题盖黑、浅色主题盖白，白天才不会糊成一团黑 */}
      {dimPlayed && ratio !== null && ratio > 0 && (
        <span
          className="kd-wave-dim"
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

      {visibleCuePoints.map((cue) => {
        const start = markerRatio(cue.start_ms, total);
        const end = markerRatio(cue.end_ms, total);
        if (start === null || end === null || end <= start) return null;
        return (
          <span
            key={`loop:${cue.id}`}
            className="kd-wave-cue-loop"
            style={{
              left: `${start * 100}%`,
              width: `${(end - start) * 100}%`,
              "--kd-cue-color": cueColor(cue),
            } as CSSProperties}
            aria-hidden="true"
          />
        );
      })}
      {visibleCuePoints.map((cue) => {
        const at = markerRatio(cue.start_ms, total);
        if (at === null) return null;
        const hot = hotCueLabel(cue.hot_cue);
        return (
          <span
            key={`cue:${cue.id}`}
            className="kd-wave-cue"
            data-kind={hot ? "hot" : "memory"}
            data-loop={cue.end_ms !== null ? "true" : undefined}
            style={{
              left: `${at * 100}%`,
              "--kd-cue-color": cueColor(cue),
              "--kd-cue-text": cueTextColor(cue),
            } as CSSProperties}
            title={cueTitle(cue)}
            aria-hidden="true"
          >
            {hot}
          </span>
        );
      })}

      {cueRatio !== null && (
        <span
          className="kd-wave-marker"
          data-kind="start"
          style={{ left: `${cueRatio * 100}%` }}
          title={`开始 ${((cueMs ?? 0) / 1000).toFixed(2)}s`}
          aria-hidden="true"
        />
      )}
      {endRatio !== null && (
        <span
          className="kd-wave-marker"
          data-kind="end"
          style={{ left: `${endRatio * 100}%` }}
          title={`结束 ${((endMs ?? 0) / 1000).toFixed(2)}s`}
          aria-hidden="true"
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

      {seekable && (
        <input
          type="range"
          min={0}
          max={Math.max(total, 1)}
          step="0.001"
          value={total > 0 && position !== null ? Math.min(total, Math.max(0, position)) : 0}
          disabled={total <= 0}
          aria-label="频谱波形，点击跳转"
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.pointerType === "mouse" && event.button !== 0) return;
            // WKWebView 的透明原生 range 在受控 value 更新时可能丢掉系统拇指跟踪。
            // 手势改由 pointer 坐标驱动；阻止原生默认动作，避免两套跟踪互相覆盖。
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            draggingRef.current = true;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // A cancelled platform gesture can make capture unavailable; in-bounds moves work.
            }
            const nextPosition = pointerPosition(event.currentTarget, event.clientX);
            previewPositionRef.current = nextPosition;
            // scrub 开始：告诉 PlayerBar 压制权威时钟，别顶回播放头。
            dispatchSeek(nextPosition, true, true);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            event.stopPropagation();
            event.preventDefault();
            previewSeek(pointerPosition(event.currentTarget, event.clientX));
          }}
          onPointerUp={(event) => {
            if (!draggingRef.current) return;
            event.stopPropagation();
            event.preventDefault();
            draggingRef.current = false;
            try {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            } catch {
              // The platform may already have released capture before this React event.
            }
            if (previewFrameRef.current !== null) {
              cancelAnimationFrame(previewFrameRef.current);
              previewFrameRef.current = null;
            }
            const finalPosition = pointerPosition(event.currentTarget, event.clientX);
            previewPositionRef.current = finalPosition;
            // 点击和拖动都只在这里落一次真实 transport；forceCommit 避免相邻位置的
            // 媒体回声去重规则误吞用户刚完成的手势。
            dispatchSeek(finalPosition, false, false, true);
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            draggingRef.current = false;
            try {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            } catch {
              // The cancelled gesture may already have released capture.
            }
            if (previewFrameRef.current !== null) {
              cancelAnimationFrame(previewFrameRef.current);
              previewFrameRef.current = null;
            }
            // scrub 中止：不发正式跳转，只松开时钟压制。
            dispatchSeek(previewPositionRef.current, true, false);
          }}
          onClick={(event) => event.stopPropagation()}
          onInput={(event) => {
            event.stopPropagation();
            if (menu || total <= 0) return;
            const nextPosition = Number(event.currentTarget.value);
            if (!draggingRef.current) {
              dispatchSeek(nextPosition);
              return;
            }
            previewSeek(nextPosition);
          }}
          style={{
            position: "absolute",
            zIndex: 5,
            inset: 0,
            width: "100%",
            height: "100%",
            margin: 0,
            cursor: "pointer",
            opacity: 0,
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            setMenuError("");
          }}
        >
          <button type="button" onClick={() => void applyPoint("start")}>
            将当前点设为开始点
          </button>
          <button type="button" onClick={() => void applyPoint("end")}>
            将当前点设为结束点
          </button>
          {menuError ? (
            <p className="kd-wave-menu-error" role="alert">
              {menuError}
            </p>
          ) : null}
        </ContextMenu>
      )}
    </div>
  );
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
