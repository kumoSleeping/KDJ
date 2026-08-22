import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { Monitor, Moon, Sun, Trash2 } from "lucide-react";
import {
  DJ_BARS_OPTIONS,
  DJ_EFFECTS,
  DJ_TRANSITIONS,
  mixSeconds,
  useDjConfig,
} from "../../lib/djMix";
import {
  HUE_LINE_GRADIENT,
  hexToT,
  needsHueLine,
  tToHex,
  type LyricsColorMode,
  type LyricsColorPaint,
} from "../../lib/lyricsColor";
import {
  accentPaint,
  DESKTOP_FONT_SCALE_MAX,
  DESKTOP_FONT_SCALE_MIN,
  DESKTOP_OPACITY_MIN,
  dimPaint,
  enginesFromMode,
  enginesMode,
  secondaryPaint,
  strokePaint,
  useLyricsPrefs,
  type LyricsEngineMode,
} from "../../lib/lyricsPrefs";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import { useTrackClickPrefs } from "../../lib/trackClickPrefs";
import {
  APP_FONT_SCALE_MAX,
  APP_FONT_SCALE_MIN,
  APP_FONT_SCALE_TICKS,
  readAppFontScale,
  setAppFontScale,
  type AppFontScale,
} from "../../lib/fontScale";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { patchEnabledPlatform } from "../../lib/enabledPlatforms";
import { normalizeEnabledPlatforms, SEARCH_PLATFORMS } from "../../lib/searchPlatforms";
import { useAppStore } from "../../stores/appStore";
import type {
  FilterResonance,
  KeyNotation,
  Quality,
  StemCompute,
  StemModelStatus,
  StreamCacheStats,
} from "../../types";
import { STEM_MODE, stemModeLabel } from "../../lib/stemMode";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { useUpdateStore } from "../../stores/updateStore";
import { Button, InlineNotice, Panel } from "../common";
import { AccountRow } from "./AccountRow";
import { UpdateRow } from "./UpdateRow";

/**
 * 「设置」住在右侧详情栏，由顶栏那颗小齿轮呼出。
 *
 * 外观：互斥分段。列表点击：横/竖屏播放手势。接播：左文右开关。接歌长度：可拖动的离散滑条。
 */

function formatSeconds(value: number): string {
  return value >= 10 ? `${Math.round(value)} 秒` : `${value.toFixed(1)} 秒`;
}

function Switch({
  checked,
  onChange,
  label,
  title,
  disabled = false,
  onState = "开",
  offState = "关",
}: {
  checked: boolean;
  onChange(): void;
  label: string;
  title?: string;
  disabled?: boolean;
  /** 右侧文案；开/关用默认，双击/单击等二元模式可覆写。 */
  onState?: string;
  offState?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={title}
      className="kd-djp-toggle"
      disabled={disabled}
      onClick={onChange}
    >
      <span className="kd-djp-toggle-label">{label}</span>
      <span className="kd-djp-toggle-state" aria-hidden="true" data-onoff={checked ? "on" : "off"}>
        {checked ? onState : offState}
      </span>
    </button>
  );
}

/** 左文右态：点击右侧文案循环搜词引擎模式。 */
function CycleToggle<T extends string>({
  label,
  value,
  options,
  onChange,
  title,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; text: string; brand?: "wyy" | "qqm" | "both" | "follow" }>;
  onChange(next: T): void;
  title?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((item) => item.id === value),
  );
  const current = options[index]!;
  return (
    <button
      type="button"
      aria-label={`${label}：${current.text}`}
      title={title}
      className="kd-djp-toggle"
      onClick={() => onChange(options[(index + 1) % options.length]!.id)}
    >
      <span className="kd-djp-toggle-label">{label}</span>
      <span
        className="kd-djp-toggle-state"
        aria-hidden="true"
        data-brand={current.brand}
      >
        {current.text}
      </span>
    </button>
  );
}

const ENGINE_MODE_OPTIONS = [
  { id: "both" as const, text: "双开", brand: "both" as const },
  { id: "wyy" as const, text: "网易云", brand: "wyy" as const },
  { id: "qqm" as const, text: "QQ", brand: "qqm" as const },
] satisfies ReadonlyArray<{ id: LyricsEngineMode; text: string; brand: "both" | "wyy" | "qqm" }>;

/** 指针拖动滑条：避开原生 range 在 Tauri 里拖不动的问题。 */
function usePointerSlider(
  trackRef: RefObject<HTMLDivElement | null>,
  pick: (t: number) => void,
  disabled = false,
) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    pick(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    pick(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return { onPointerDown, onPointerMove, onPointerUp };
}

/** 离散档位滑条（接歌小节）。 */
function BarsSlider({
  bars,
  onChange,
  hint,
}: {
  bars: number;
  onChange(next: number): void;
  hint: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    DJ_BARS_OPTIONS.findIndex((value) => value === bars),
  );
  const max = DJ_BARS_OPTIONS.length - 1;
  const fill = max <= 0 ? 0 : index / max;
  const handlers = usePointerSlider(trackRef, (t) => {
    const next = DJ_BARS_OPTIONS[Math.round(t * max)];
    if (next != null) onChange(next);
  });

  return (
    <div className="kd-djp-slider-block" title={hint}>
      <div className="kd-djp-slider-row">
        <div className="kd-djp-slider-main">
          <div
            ref={trackRef}
            className="kd-djp-slider"
            role="slider"
            tabIndex={0}
            aria-label="接歌长度"
            aria-valuemin={DJ_BARS_OPTIONS[0]}
            aria-valuemax={DJ_BARS_OPTIONS[max]}
            aria-valuenow={bars}
            aria-valuetext={`${bars} 小节`}
            style={{ "--kd-djp-fill": `${fill * 100}%` } as CSSProperties}
            {...handlers}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                event.preventDefault();
                onChange(DJ_BARS_OPTIONS[Math.max(0, index - 1)]!);
              } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                event.preventDefault();
                onChange(DJ_BARS_OPTIONS[Math.min(max, index + 1)]!);
              } else if (event.key === "Home") {
                event.preventDefault();
                onChange(DJ_BARS_OPTIONS[0]!);
              } else if (event.key === "End") {
                event.preventDefault();
                onChange(DJ_BARS_OPTIONS[max]!);
              }
            }}
          >
            <span className="kd-djp-slider-track" aria-hidden="true" />
          </div>
          <div className="kd-djp-slider-ticks" aria-hidden="true">
            {DJ_BARS_OPTIONS.map((value) => (
              <span key={value} className="kd-num">
                {value}
              </span>
            ))}
          </div>
        </div>
        <span className="kd-djp-slider-value kd-num">
          {bars} 小节
          <small>{hint}</small>
        </span>
      </div>
    </div>
  );
}

/** 主界面字号：75–150%，鼠标和方向键都可按 1% 微调。 */
function FontScaleSlider({
  value,
  onChange,
}: {
  value: AppFontScale;
  onChange(next: AppFontScale): void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = APP_FONT_SCALE_MAX - APP_FONT_SCALE_MIN;
  const fill = span <= 0 ? 0 : (value - APP_FONT_SCALE_MIN) / span;
  const choose = (nextValue: number) => {
    onChange(Math.max(APP_FONT_SCALE_MIN, Math.min(APP_FONT_SCALE_MAX, Math.round(nextValue))));
  };
  const handlers = usePointerSlider(trackRef, (t) => choose(APP_FONT_SCALE_MIN + t * span));

  return (
    <div className="kd-djp-slider-block" title="调整主界面的文字大小；悬浮歌词可在歌词设置中单独调整。">
      <div className="kd-djp-slider-row">
        <div className="kd-djp-slider-main">
          <div
            ref={trackRef}
            className="kd-djp-slider"
            role="slider"
            tabIndex={0}
            aria-label="界面字号"
            aria-valuemin={APP_FONT_SCALE_MIN}
            aria-valuemax={APP_FONT_SCALE_MAX}
            aria-valuenow={value}
            aria-valuetext={`${value}%`}
            style={{ "--kd-djp-fill": `${fill * 100}%` } as CSSProperties}
            {...handlers}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                event.preventDefault();
                choose(value - 1);
              } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                event.preventDefault();
                choose(value + 1);
              } else if (event.key === "PageDown") {
                event.preventDefault();
                choose(value - 5);
              } else if (event.key === "PageUp") {
                event.preventDefault();
                choose(value + 5);
              } else if (event.key === "Home") {
                event.preventDefault();
                choose(APP_FONT_SCALE_MIN);
              } else if (event.key === "End") {
                event.preventDefault();
                choose(APP_FONT_SCALE_MAX);
              }
            }}
          >
            <span className="kd-djp-slider-track" aria-hidden="true" />
          </div>
          <div className="kd-djp-slider-ticks" aria-hidden="true">
            {APP_FONT_SCALE_TICKS.map((scale) => (
              <span key={scale} className="kd-num">
                {scale}
              </span>
            ))}
          </div>
        </div>
        <span className="kd-djp-slider-value kd-num">
          {value}%
          <small>界面字号</small>
        </span>
      </div>
    </div>
  );
}

/** 连续百分比滑条：视觉与接歌小节同一套 2px 红/灰线。 */
function RatioSlider({
  label,
  ariaLabel,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  value: number;
  onChange(next: number): void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = max - min;
  const fill = span <= 0 ? 0 : (value - min) / span;
  const pct = Math.round(value * 100);
  const handlers = usePointerSlider(trackRef, (t) => onChange(min + t * span), disabled);

  return (
    <div className="kd-lyrics-size-row" data-disabled={disabled || undefined}>
      <span className="kd-djp-toggle-label">{label}</span>
      <div
        ref={trackRef}
        className="kd-djp-slider"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
        aria-disabled={disabled || undefined}
        style={{ "--kd-djp-fill": `${fill * 100}%` } as CSSProperties}
        {...handlers}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = 0.05;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onChange(value - step);
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onChange(value + step);
          } else if (event.key === "Home") {
            event.preventDefault();
            onChange(min);
          } else if (event.key === "End") {
            event.preventDefault();
            onChange(max);
          }
        }}
      >
        <span className="kd-djp-slider-track" aria-hidden="true" />
      </div>
    </div>
  );
}

const FILL_MODE_OPTIONS = [
  { id: "black" as const, text: "黑" },
  { id: "white" as const, text: "白" },
  { id: "solid" as const, text: "单色" },
  { id: "gradient" as const, text: "渐变" },
] satisfies ReadonlyArray<{ id: LyricsColorMode; text: string }>;

const DIM_MODE_OPTIONS = [
  { id: "black" as const, text: "黑" },
  { id: "white" as const, text: "白" },
  { id: "gray" as const, text: "灰" },
  { id: "solid" as const, text: "单色" },
  { id: "gradient" as const, text: "渐变" },
] satisfies ReadonlyArray<{ id: LyricsColorMode; text: string }>;

const SECONDARY_MODE_OPTIONS = [
  { id: "follow" as const, text: "跟随" },
  ...FILL_MODE_OPTIONS,
] satisfies ReadonlyArray<{ id: LyricsColorMode; text: string }>;

const STROKE_MODE_OPTIONS = [
  { id: "black" as const, text: "黑" },
  { id: "white" as const, text: "白" },
  { id: "solid" as const, text: "单色" },
  { id: "gradient" as const, text: "渐变" },
  { id: "none" as const, text: "无" },
] satisfies ReadonlyArray<{ id: LyricsColorMode; text: string }>;

/**
 * 悬浮歌词取色行：右侧在「黑 / 白 / 单色 / 渐变」（边框多「无」、副行多「跟随」、未唱多「灰」）间切换；
 * 单色 / 渐变时下面一根纯彩色相线——单色一个尖朝下三角标，渐变左右两个。
 */
function LyricsColorRow({
  label,
  title,
  value,
  onChange,
  allowNone = false,
  allowFollow = false,
  allowGray = false,
}: {
  label: string;
  title?: string;
  value: LyricsColorPaint;
  onChange(next: LyricsColorPaint): void;
  allowNone?: boolean;
  allowFollow?: boolean;
  allowGray?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<"start" | "end">("start");
  const [active, setActive] = useState<"start" | "end">("start");
  const startT = hexToT(value.start);
  const endT = hexToT(value.end);
  const gradient = value.mode === "gradient";
  const showHue = needsHueLine(value.mode);
  const options = allowNone
    ? STROKE_MODE_OPTIONS
    : allowFollow
      ? SECONDARY_MODE_OPTIONS
      : allowGray
        ? DIM_MODE_OPTIONS
        : FILL_MODE_OPTIONS;

  const applyT = (t: number, which: "start" | "end") => {
    const hex = tToHex(t);
    if (!gradient || which === "start") {
      onChange({ ...value, start: hex });
      return;
    }
    onChange({ ...value, end: hex });
  };

  const pickHandle = (t: number): "start" | "end" => {
    if (!gradient) return "start";
    return Math.abs(t - startT) <= Math.abs(t - endT) ? "start" : "end";
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const which = pickHandle(t);
    activeRef.current = which;
    setActive(which);
    applyT(t, which);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    applyT(t, activeRef.current);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="kd-lyrics-color-block" title={title}>
      <CycleToggle
        label={label}
        value={value.mode}
        options={options}
        title={title}
        onChange={(mode) => onChange({ ...value, mode })}
      />
      {showHue ? (
        <div
          ref={trackRef}
          className="kd-lyrics-hue-line"
          role="slider"
          tabIndex={0}
          aria-label={`${label}色相`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((gradient && active === "end" ? endT : startT) * 100)}
          style={{ background: HUE_LINE_GRADIENT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={(event) => {
            const which = gradient ? active : "start";
            const current = which === "end" ? endT : startT;
            const step = 0.02;
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              applyT(current - step, which);
            } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              applyT(current + step, which);
            } else if (event.key === "Home") {
              event.preventDefault();
              applyT(0, which);
            } else if (event.key === "End") {
              event.preventDefault();
              applyT(1, which);
            } else if (gradient && (event.key === "[" || event.key === "]")) {
              event.preventDefault();
              const next = event.key === "[" ? "start" : "end";
              activeRef.current = next;
              setActive(next);
            }
          }}
        >
          <span
            className="kd-lyrics-hue-knob"
            data-active={!gradient || active === "start" ? "true" : undefined}
            style={{ left: `${startT * 100}%`, background: value.start }}
            aria-hidden="true"
          />
          {gradient ? (
            <span
              className="kd-lyrics-hue-knob"
              data-active={active === "end" ? "true" : undefined}
              style={{ left: `${endT * 100}%`, background: value.end }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsPanel() {
  const theme = useAppStore((state) => state.settings?.theme ?? "system");
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [appFontScale, setFontScale] = useState(readAppFontScale);
  const [streamCacheStats, setStreamCacheStats] = useState<StreamCacheStats | null>(null);
  const [streamCacheBusy, setStreamCacheBusy] = useState(false);
  const [streamCacheError, setStreamCacheError] = useState("");
  const [stemModel, setStemModel] = useState<StemModelStatus | null>(null);
  const [stemModelBusy, setStemModelBusy] = useState(false);
  const transitions = useDjConfig((state) => state.transitions);
  const effects = useDjConfig((state) => state.effects);
  const bars = useDjConfig((state) => state.bars);
  const vocalCut = useDjConfig((state) => state.vocalCut);
  const applyInOutPoints = useDjConfig((state) => state.applyInOutPoints);
  const autoBeatSync = useDjConfig((state) => state.autoBeatSync);
  const playOnLoad = useDjConfig((state) => state.playOnLoad);
  const toggleTransition = useDjConfig((state) => state.toggleTransition);
  const toggleEffect = useDjConfig((state) => state.toggleEffect);
  const setBars = useDjConfig((state) => state.setBars);
  const setVocalCut = useDjConfig((state) => state.setVocalCut);
  const setApplyInOutPoints = useDjConfig((state) => state.setApplyInOutPoints);
  const setAutoBeatSync = useDjConfig((state) => state.setAutoBeatSync);
  const setPlayOnLoad = useDjConfig((state) => state.setPlayOnLoad);

  const widePlay = useTrackClickPrefs((state) => state.widePlay);
  const setWidePlay = useTrackClickPrefs((state) => state.setWidePlay);
  const transportFade = usePlaybackPrefs((state) => state.transportFade);
  const setTransportFade = usePlaybackPrefs((state) => state.setTransportFade);
  const quantize = usePlaybackPrefs((state) => state.quantize);
  const setQuantize = usePlaybackPrefs((state) => state.setQuantize);
  const lyricsEngines = useLyricsPrefs((state) => state.engines);
  const setLyricsEngines = useLyricsPrefs((state) => state.setEngines);
  const tryOnlineWhenMissing = useLyricsPrefs((state) => state.tryOnlineWhenMissing);
  const setTryOnlineWhenMissing = useLyricsPrefs((state) => state.setTryOnlineWhenMissing);
  const desktopLyricsLocked = useLyricsPrefs((state) => state.desktopLocked);
  const desktopLyricsFontScale = useLyricsPrefs((state) => state.desktopFontScale);
  const desktopLyricsOpacity = useLyricsPrefs((state) => state.desktopOpacity);
  const desktopAccentMode = useLyricsPrefs((state) => state.desktopAccentMode);
  const desktopAccentStart = useLyricsPrefs((state) => state.desktopAccent);
  const desktopAccentEnd = useLyricsPrefs((state) => state.desktopAccentEnd);
  const desktopSecondaryMode = useLyricsPrefs((state) => state.desktopSecondaryMode);
  const desktopSecondaryStart = useLyricsPrefs((state) => state.desktopSecondaryAccent);
  const desktopSecondaryEnd = useLyricsPrefs((state) => state.desktopSecondaryAccentEnd);
  const desktopDimMode = useLyricsPrefs((state) => state.desktopDimMode);
  const desktopDimStart = useLyricsPrefs((state) => state.desktopDim);
  const desktopDimEnd = useLyricsPrefs((state) => state.desktopDimEnd);
  const desktopStrokeMode = useLyricsPrefs((state) => state.desktopStrokeMode);
  const desktopStrokeStart = useLyricsPrefs((state) => state.desktopStroke);
  const desktopStrokeEnd = useLyricsPrefs((state) => state.desktopStrokeEnd);
  const setDesktopLyricsLocked = useLyricsPrefs((state) => state.setDesktopLocked);
  const setDesktopLyricsFontScale = useLyricsPrefs((state) => state.setDesktopFontScale);
  const setDesktopAccentPaint = useLyricsPrefs((state) => state.setDesktopAccentPaint);
  const setDesktopSecondaryPaint = useLyricsPrefs((state) => state.setDesktopSecondaryPaint);
  const setDesktopDimPaint = useLyricsPrefs((state) => state.setDesktopDimPaint);
  const setDesktopStrokePaint = useLyricsPrefs((state) => state.setDesktopStrokePaint);
  const setDesktopLyricsOpacity = useLyricsPrefs((state) => state.setDesktopOpacity);
  const desktopAccent = accentPaint({
    desktopAccentMode,
    desktopAccent: desktopAccentStart,
    desktopAccentEnd,
  });
  const desktopSecondary = secondaryPaint({
    desktopSecondaryMode,
    desktopSecondaryAccent: desktopSecondaryStart,
    desktopSecondaryAccentEnd: desktopSecondaryEnd,
  });
  const desktopDim = dimPaint({
    desktopDimMode,
    desktopDim: desktopDimStart,
    desktopDimEnd,
  });
  const desktopStroke = strokePaint({
    desktopStrokeMode,
    desktopStroke: desktopStrokeStart,
    desktopStrokeEnd,
  });
  // 桌面是独立置顶窗口，Android 是原生浮层；两边都由这组设置驱动。
  // 浏览器预览和 iOS 没有悬浮歌词，桥接层那边就是 null。
  const canOverlayLyrics = Boolean(window.kdj?.desktopLyrics);
  const overlayIsNative = Boolean(window.kdj?.overlayPermission);

  const accounts = useAppStore((state) => state.accounts);
  const accountsError = useAppStore((state) => state.accountsError);
  const refreshAccounts = useAppStore((state) => state.refreshAccounts);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void api
        .streamCacheStats()
        .then((stats) => {
          if (!disposed) {
            setStreamCacheStats(stats);
            setStreamCacheError("");
          }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            setStreamCacheError(error instanceof Error ? error.message : String(error));
          }
        });
    };
    refresh();
    // 关闭/清理后仍短轮询：在途 writer 会异步收尾，不能把“缓存中”永久留在 UI。
    // stats 会枚举缓存目录；设置面板停留时无需每 3 秒唤醒下载盘。
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [settings?.download_dir, settings?.stream_cache_enabled]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void api.stemModelStatus(
        STEM_MODE,
        settings?.stem_compute ?? "auto",
      ).then((status) => {
        if (!disposed) setStemModel(status);
      }).catch(() => {
        // The settings panel remains usable if an older local server has no STEM endpoint.
      });
    };
    refresh();
    const timer = window.setInterval(
      refresh,
      stemModel?.state === "downloading" || stemModel?.state === "queued" ? 500 : 5000,
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [settings?.stem_compute, stemModel?.state]);

  const downloadStemModel = async () => {
    if (stemModelBusy) return;
    setStemModelBusy(true);
    try {
      setStemModel(await api.downloadStemModel(
        STEM_MODE,
        settings?.stem_compute ?? "auto",
      ));
    } catch (error) {
      setStemModel((current) => current ? {
        ...current,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      } : current);
    } finally {
      setStemModelBusy(false);
    }
  };

  const toggleStreamCache = async () => {
    if (!settings || streamCacheBusy) return;
    setStreamCacheBusy(true);
    setStreamCacheError("");
    await saveSettings({ stream_cache_enabled: !settings.stream_cache_enabled });
    try {
      setStreamCacheStats(await api.streamCacheStats());
    } catch (error) {
      setStreamCacheError(error instanceof Error ? error.message : String(error));
    } finally {
      setStreamCacheBusy(false);
    }
  };

  const clearStreamCache = async () => {
    if (streamCacheBusy) return;
    setStreamCacheBusy(true);
    setStreamCacheError("");
    try {
      setStreamCacheStats(await api.clearStreamCache());
    } catch (error) {
      setStreamCacheError(error instanceof Error ? error.message : String(error));
    } finally {
      setStreamCacheBusy(false);
    }
  };

  const selected = useLibraryStore(selectSelectedTrack);
  const bpm = selected?.bpm ?? null;
  const bpmLabel = bpm ? `${Math.round(bpm)} BPM` : "120 BPM（未分析，按默认估）";
  const lengthHint = `约 ${formatSeconds(mixSeconds(bpm, bars))} · ${bpmLabel}`;

  const accountRows = accounts.filter((account) => account.supports_login);
  const autoCheck = useUpdateStore((s) => s.autoCheck);
  const setAutoCheck = useUpdateStore((s) => s.setAutoCheck);
  const focusEpoch = useUpdateStore((s) => s.focusEpoch);
  const updateSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusEpoch) return;
    let frame = 0;
    const scrollToUpdate = () => {
      const section = updateSectionRef.current;
      if (!section) {
        if (frame++ < 8) requestAnimationFrame(scrollToUpdate);
        return;
      }
      const scrollHost = section.closest(".kd-scroll") as HTMLElement | null;
      if (!scrollHost) return;
      const top =
        section.getBoundingClientRect().top -
        scrollHost.getBoundingClientRect().top +
        scrollHost.scrollTop;
      scrollHost.scrollTo({ top: Math.max(0, top), behavior: frame > 0 ? "auto" : "smooth" });
    };
    scrollToUpdate();
  }, [focusEpoch]);

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-scroll kd-djp" style={{ minHeight: 0 }}>
        <Panel heading="外观" dense>
          <div
            className="kd-djp-choice kd-djp-theme"
            role="radiogroup"
            aria-label="外观主题"
          >
            {(
              [
                ["light", "浅色", Sun],
                ["dark", "深色", Moon],
                ["system", "跟随系统", Monitor],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                aria-label={label}
                title={label}
                className="kd-djp-theme-btn"
                data-theme={value}
                onClick={() => void saveSettings({ theme: value })}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            ))}
          </div>
          <FontScaleSlider
            value={appFontScale}
            onChange={(next) => {
              setFontScale(next);
              setAppFontScale(next);
            }}
          />
        </Panel>

        <Panel heading="列表点击" dense>
          <div className="kd-djp-switch-list" aria-label="列表点击">
            <Switch
              checked={widePlay === "double"}
              label="横屏播放"
              onState="双击"
              offState="单击"
              title="横屏下列表点播放的手势：双击播放（单击选中），或改成单击即播。"
              onChange={() => setWidePlay(widePlay === "double" ? "single" : "double")}
            />
            <Switch
              checked
              disabled
              label="竖屏播放"
              onState="单击"
              offState="单击"
              title="移动端歌曲列表固定单击播放；详情请点底部正在播放的歌曲。"
              onChange={() => undefined}
            />
          </div>
        </Panel>

        <Panel heading="播放" dense>
          <div className="kd-djp-switch-list" aria-label="播放选项">
            <Switch
              checked={transportFade}
              label="播放 / 暂停渐入渐出"
              title="播放时用约 120 毫秒渐入，暂停时用约 120 毫秒渐出；关掉后立即播放或暂停。"
              onChange={() => setTransportFade(!transportFade)}
            />
            <Switch
              checked={quantize}
              label="节拍量化"
              title="主 CUE、Hot Cue 与 Loop 起点吸附到分析节拍网格。"
              onChange={() => setQuantize(!quantize)}
            />
            <CycleToggle<FilterResonance>
              label="FILTER 共振"
              value={settings?.filter_resonance ?? "high"}
              options={[
                { id: "low", text: "低" },
                { id: "medium", text: "中" },
                { id: "high", text: "高" },
              ]}
              title="Performance 双极 FILTER 的共振强度。高档为默认；低档与此前的固定滤波响应一致。"
              onChange={(next) => void saveSettings({ filter_resonance: next })}
            />
          </div>
        </Panel>

        <Panel heading="STEM" dense>
          <div className="kd-djp-switch-list" aria-label="STEM 选项">
            <CycleToggle<StemCompute>
              label="运算设备"
              value={settings?.stem_compute ?? "auto"}
              options={[
                { id: "auto", text: "自动" },
                { id: "gpu", text: "GPU" },
                { id: "cpu", text: "CPU" },
              ]}
              title="自动优先 CoreML、DirectML 或 NNAPI；不可用时回退 CPU。强制 GPU 不会静默回退。"
              onChange={(next) => void saveSettings({ stem_compute: next })}
            />
          </div>
          {settings ? (
            <>
              <div className="kd-stream-cache-row">
                <span className="kd-muted">
                  {stemModel?.state === "ready"
                    ? `${stemModeLabel(STEM_MODE)} ${stemModel.version} · 已安装${stemModel.diagnostics.provider ? ` · ${stemModel.diagnostics.provider}` : ""}`
                    : stemModel?.state === "downloading" || stemModel?.state === "queued"
                      ? `${stemModeLabel(STEM_MODE)} · ${Math.round(stemModel.progress * 100)}% · ${formatBytes(stemModel.downloadedBytes)}`
                      : stemModel?.state === "unsupported"
                        ? "当前平台尚未提供 STEM runtime"
                        : `${stemModeLabel(STEM_MODE)} · ${formatBytes(stemModel?.totalBytes ?? 0)}`}
                </span>
                {stemModel?.supported && stemModel.state !== "ready" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={stemModelBusy || stemModel.state === "downloading" || stemModel.state === "queued"}
                    onClick={() => void downloadStemModel()}
                  >
                    {stemModel.state === "error" ? "重试" : "下载模型"}
                  </Button>
                ) : null}
              </div>
              <InlineNotice
                text={stemModel?.error ?? ""}
                block
                onDismiss={() => setStemModel((current) => current ? { ...current, error: "" } : current)}
              />
            </>
          ) : null}
        </Panel>

        <Panel heading="OneLibrary" dense>
          <div className="kd-djp-switch-list" aria-label="OneLibrary 选项">
            <CycleToggle<KeyNotation>
              label="列表调性"
              value={settings?.key_notation ?? "camelot"}
              options={[
                { id: "camelot", text: "Camelot" },
                { id: "traditional", text: "音名" },
              ]}
              title="本地与 OneLibrary 歌曲列表统一显示 Camelot 数字制或传统音名；不会改写曲目数据。"
              onChange={(next) => void saveSettings({ key_notation: next })}
            />
            <Switch
              checked={settings?.virtual_disk_auto_grow ?? true}
              disabled={!settings}
              label="空间不足时自动迁移至更大的镜像"
              title="仅用于 KDJ 虚拟磁盘；关闭后空间不足会停止写入并报错。"
              onChange={() =>
                void saveSettings({
                  virtual_disk_auto_grow: !(settings?.virtual_disk_auto_grow ?? true),
                })
              }
            />
          </div>
        </Panel>

        <Panel heading="流媒体播放" dense>
          <div className="kd-djp-switch-list" aria-label="流媒体播放">
            <CycleToggle<Quality>
              label="音质"
              value={settings?.stream_quality ?? "128"}
              options={[
                { id: "128", text: "128K" },
                { id: "320", text: "320K" },
                { id: "flac", text: "FLAC" },
              ]}
              title="在线流媒体播放请求的起始音质；平台、版权或会员不允许时会自动降级。"
              onChange={(next) => void saveSettings({ stream_quality: next })}
            />
            <CycleToggle
              label="视频画质"
              value={String(settings?.video_playback_max_height ?? 1080)}
              options={[
                { id: "360", text: "360p" },
                { id: "480", text: "480p" },
                { id: "720", text: "720p" },
                { id: "1080", text: "1080p" },
                { id: "2160", text: "4K" },
              ]}
              title="视频在线播放画质上限；实际画质仍由平台账号和视频本身决定。"
              onChange={(next) => void saveSettings({ video_playback_max_height: Number(next) })}
            />
            <Switch
              checked={settings?.stream_cache_enabled ?? false}
              disabled={!settings || streamCacheBusy}
              label="缓存在线播放"
              title={
                streamCacheStats?.path
                  ? `完整音频在后台写入 ${streamCacheStats.path}；命中后直接从本地播放。`
                  : "完整音频在后台写入下载目录的 .kdj/stream-cache；命中后直接从本地播放。"
              }
              onChange={() => void toggleStreamCache()}
            />
            <div className="kd-stream-cache-row" title={streamCacheStats?.path}>
              <span className="kd-muted">
                {streamCacheStats
                  ? `${streamCacheStats.files} 首 · ${formatBytes(streamCacheStats.bytes)}`
                  : "正在读取缓存…"}
                {streamCacheStats?.active_writes
                  ? ` · ${streamCacheStats.active_writes} 首缓存中`
                  : streamCacheStats?.partial_files
                    ? ` · ${streamCacheStats.partial_files} 个未完成 · ${formatBytes(streamCacheStats.partial_bytes)}`
                    : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  streamCacheBusy ||
                  !streamCacheStats ||
                  (streamCacheStats.files === 0 &&
                    streamCacheStats.partial_files === 0 &&
                    streamCacheStats.active_writes === 0)
                }
                title="清理已完成和未完成的在线播放缓存"
                onClick={() => void clearStreamCache()}
              >
                <Trash2 size={12} aria-hidden="true" />
                清理
              </Button>
            </div>
            <InlineNotice
              text={streamCacheError}
              block
              onDismiss={() => setStreamCacheError("")}
            />
          </div>
        </Panel>

        <Panel heading="歌词" dense>
          <div className="kd-djp-switch-list" aria-label="歌词选项">
            <Switch
              checked={settings?.download_lyrics ?? true}
              label="下载歌词"
              title="下载音频后按当前平台歌曲 ID 获取 LRC，保存到歌曲所在目录的 .kdj/lyrics/；歌词失败不影响歌曲下载。"
              onChange={() => void saveSettings({ download_lyrics: !(settings?.download_lyrics ?? true) })}
            />
            <Switch
              checked={tryOnlineWhenMissing}
              label="无歌词时尝试匹配"
              title="本地 .kdj/lyrics/ 没有歌词时，才按曲名、艺人和时长在线匹配；关闭后只使用本地歌词。在线试听仍按来源 ID 取词。"
              onChange={() => setTryOnlineWhenMissing(!tryOnlineWhenMissing)}
            />
            {canOverlayLyrics ? (
              <>
                <Switch
                  checked={desktopLyricsLocked}
                  label={overlayIsNative ? "触摸穿透（开启后不能拖动）" : "鼠标穿透（开启后不能拖动）"}
                  title={
                    overlayIsNative
                      ? "关闭时按住歌词即可上下拖动；开启后触摸会穿过歌词浮层落到下面的应用，需要回这里关闭才能再次拖动。"
                      : "关闭时按住歌词即可自由拖动；开启后点击会穿过歌词窗口，需要回这里关闭才能再次拖动。"
                  }
                  onChange={() => setDesktopLyricsLocked(!desktopLyricsLocked)}
                />
                <RatioSlider
                  label="悬浮字号"
                  ariaLabel="悬浮歌词字号"
                  min={DESKTOP_FONT_SCALE_MIN}
                  max={DESKTOP_FONT_SCALE_MAX}
                  value={desktopLyricsFontScale}
                  onChange={setDesktopLyricsFontScale}
                />
                <RatioSlider
                  label="不透明度"
                  ariaLabel="悬浮歌词不透明度"
                  min={DESKTOP_OPACITY_MIN}
                  max={1}
                  value={desktopLyricsOpacity}
                  onChange={setDesktopLyricsOpacity}
                />
                <LyricsColorRow
                  label={overlayIsNative ? "高亮色" : "主行颜色"}
                  title="主行已唱部分：黑 / 白 / 单色（色相线）/ 渐变。超长句跟着进度滚动。"
                  value={desktopAccent}
                  onChange={setDesktopAccentPaint}
                />
                <LyricsColorRow
                  label="副行颜色"
                  title="翻译或下一句已唱部分：跟随主行 / 黑 / 白 / 单色 / 渐变。超长句跟着进度滚动。"
                  value={desktopSecondary}
                  onChange={setDesktopSecondaryPaint}
                  allowFollow
                />
                <LyricsColorRow
                  label="未唱颜色"
                  title="还没唱到的字：黑 / 白 / 灰 / 单色 / 渐变。主行与副行共用。"
                  value={desktopDim}
                  onChange={setDesktopDimPaint}
                  allowGray
                />
                <LyricsColorRow
                  label="边框颜色"
                  title="描边（整行始终绘制）：黑 / 白 / 单色 / 渐变 / 无。"
                  value={desktopStroke}
                  onChange={setDesktopStrokePaint}
                  allowNone
                />
              </>
            ) : null}
            <CycleToggle
              label="搜词引擎"
              value={enginesMode(lyricsEngines)}
              options={ENGINE_MODE_OPTIONS}
              title="点击切换：双开 / 仅网易云 / 仅 QQ。至少保留一家。"
              onChange={(mode) => setLyricsEngines(enginesFromMode(mode))}
            />
          </div>
        </Panel>

        <Panel heading="接播" dense>
          <div className="kd-djp-groups">
            <div className="kd-djp-switch-list" aria-label="接播选项">
              {DJ_TRANSITIONS.map((item) => (
                <Switch
                  key={item.id}
                  checked={transitions.includes(item.id)}
                  label={item.label}
                  title={`${item.hint}。每次接歌会从已选方案中随机组合。`}
                  onChange={() => toggleTransition(item.id)}
                />
              ))}
              <Switch
                checked={vocalCut}
                label="人声渐消"
                title="接歌时渐进削弱上一首的中置人声；保留立体声侧声道和补偿增益。"
                onChange={() => setVocalCut(!vocalCut)}
              />
              <Switch
                checked={applyInOutPoints}
                label="应用开始 / 结束点"
                title="自动接播与自动续播时：有开始点就从那里起播，有结束点就到点切下一首；关掉则按首拍起播、波形尾段切歌。"
                onChange={() => setApplyInOutPoints(!applyInOutPoints)}
              />
              <Switch
                checked={autoBeatSync}
                label="自动对拍"
                title="开启后：点波形落到被点小节内与当前播放相同的相位；SYNC 锁小节（黄线对齐）；接歌等到下一小节边界。关掉则点击精确落点，SYNC 只锁拍子（灰线对齐）。"
                onChange={() => setAutoBeatSync(!autoBeatSync)}
              />
              <Switch
                checked={playOnLoad}
                label="加载后立即播放"
                title="DJ 模式下把曲目装入 Deck 后立即从首拍起播；关掉则只装盘，停在首拍等你按播放。"
                onChange={() => setPlayOnLoad(!playOnLoad)}
              />
              {DJ_EFFECTS.map((item) => (
                <Switch
                  key={item.id}
                  checked={effects.includes(item.id)}
                  label={item.label}
                  title={`${item.hint}。强度会在接歌过程中自动推进。`}
                  onChange={() => toggleEffect(item.id)}
                />
              ))}
            </div>

            <div className="kd-djp-group">
              <span className="kd-djp-label">接歌长度</span>
              <BarsSlider bars={bars} onChange={setBars} hint={lengthHint} />
            </div>
          </div>
        </Panel>

        <Panel heading="下载源" dense>
          <div className="kd-djp-switch-list" aria-label="下载源">
            {SEARCH_PLATFORMS.map((item) => {
              const enabled = normalizeEnabledPlatforms(settings?.enabled_platforms).includes(
                item.id,
              );
              return (
                <Switch
                  key={item.id}
                  checked={enabled}
                  label={item.label}
                  title={
                    enabled
                      ? `关闭后搜索条里「${item.label}」会变灰，也无法搜索或下载`
                      : `开启后可在搜索条勾选「${item.label}」`
                  }
                  onChange={() => {
                    if (!settings) return;
                    // 最后一个开着的不准关。
                    const current = normalizeEnabledPlatforms(settings.enabled_platforms);
                    if (enabled && current.length <= 1) return;
                    void saveSettings(patchEnabledPlatform(settings, item.id, !enabled));
                  }}
                />
              );
            })}
          </div>
        </Panel>

        <Panel heading="账号" dense>
          <InlineNotice text={accountsError} block />
          {accountRows.length === 0 ? (
            <p className="kd-muted">账号状态还没拉到，稍等一下。</p>
          ) : (
            accountRows.map((account) => <AccountRow key={account.platform} account={account} />)
          )}
        </Panel>

        <div ref={updateSectionRef} id="kd-settings-update">
          <Panel heading="软件更新" dense>
            <UpdateRow />
            <div className="kd-djp-switch-list" style={{ marginTop: "0.35rem" }}>
              <Switch
                checked={autoCheck}
                label="自动检测更新"
                title="启动时检查一次，之后每 5 分钟静默检查；关掉后只保留手动检查。"
                onChange={() => setAutoCheck(!autoCheck)}
              />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
