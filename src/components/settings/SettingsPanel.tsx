import { useEffect, useRef } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  DJ_BARS_OPTIONS,
  DJ_EFFECTS,
  DJ_TRANSITIONS,
  mixSeconds,
  useDjConfig,
} from "../../lib/djMix";
import {
  DESKTOP_FONT_SCALE_MAX,
  DESKTOP_FONT_SCALE_MIN,
  DESKTOP_OPACITY_MIN,
  enginesFromMode,
  enginesMode,
  useLyricsPrefs,
  type LyricsEngineMode,
} from "../../lib/lyricsPrefs";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import { useTrackClickPrefs } from "../../lib/trackClickPrefs";
import { useAppStore } from "../../stores/appStore";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { useUpdateStore } from "../../stores/updateStore";
import { InlineNotice, Panel } from "../common";
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

export function SettingsPanel() {
  const theme = useAppStore((state) => state.settings?.theme ?? "system");
  const saveSettings = useAppStore((state) => state.saveSettings);
  const transitions = useDjConfig((state) => state.transitions);
  const effects = useDjConfig((state) => state.effects);
  const bars = useDjConfig((state) => state.bars);
  const vocalCut = useDjConfig((state) => state.vocalCut);
  const applyInOutPoints = useDjConfig((state) => state.applyInOutPoints);
  const toggleTransition = useDjConfig((state) => state.toggleTransition);
  const toggleEffect = useDjConfig((state) => state.toggleEffect);
  const setBars = useDjConfig((state) => state.setBars);
  const setVocalCut = useDjConfig((state) => state.setVocalCut);
  const setApplyInOutPoints = useDjConfig((state) => state.setApplyInOutPoints);

  const widePlay = useTrackClickPrefs((state) => state.widePlay);
  const narrowPlay = useTrackClickPrefs((state) => state.narrowPlay);
  const clickAddNext = useTrackClickPrefs((state) => state.clickAddNext);
  const setWidePlay = useTrackClickPrefs((state) => state.setWidePlay);
  const setNarrowPlay = useTrackClickPrefs((state) => state.setNarrowPlay);
  const setClickAddNext = useTrackClickPrefs((state) => state.setClickAddNext);
  const addNextAvailable = widePlay === "double" || narrowPlay === "double";
  const transportFade = usePlaybackPrefs((state) => state.transportFade);
  const setTransportFade = usePlaybackPrefs((state) => state.setTransportFade);
  const lyricsEngines = useLyricsPrefs((state) => state.engines);
  const setLyricsEngines = useLyricsPrefs((state) => state.setEngines);
  const desktopLyricsPosition = useLyricsPrefs((state) => state.desktopPosition);
  const desktopLyricsLocked = useLyricsPrefs((state) => state.desktopLocked);
  const desktopLyricsFontScale = useLyricsPrefs((state) => state.desktopFontScale);
  const desktopLyricsAccent = useLyricsPrefs((state) => state.desktopAccent);
  const desktopLyricsOpacity = useLyricsPrefs((state) => state.desktopOpacity);
  const setDesktopLyricsPosition = useLyricsPrefs((state) => state.setDesktopPosition);
  const setDesktopLyricsLocked = useLyricsPrefs((state) => state.setDesktopLocked);
  const setDesktopLyricsFontScale = useLyricsPrefs((state) => state.setDesktopFontScale);
  const setDesktopLyricsAccent = useLyricsPrefs((state) => state.setDesktopAccent);
  const setDesktopLyricsOpacity = useLyricsPrefs((state) => state.setDesktopOpacity);
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
              checked={narrowPlay === "single"}
              label="竖屏播放"
              onState="单击"
              offState="双击"
              title="竖屏下列表点播放的手势：默认单击即播，也可改成双击。"
              onChange={() => setNarrowPlay(narrowPlay === "single" ? "double" : "single")}
            />
            <Switch
              checked={clickAddNext}
              disabled={!addNextAvailable}
              label="单击插入下一首待播"
              title={
                addNextAvailable
                  ? "播放设为双击时：单击把歌插到临时列表队头（下一首待播），双击仍负责播放。"
                  : "需要先把横屏或竖屏的播放手势设为双击，单击才有空档留给「插入下一首待播」。"
              }
              onChange={() => setClickAddNext(!clickAddNext)}
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
          </div>
        </Panel>

        <Panel heading="歌词" dense>
          <div className="kd-djp-switch-list" aria-label="歌词选项">
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
                <Switch
                  checked={desktopLyricsPosition === "bottom"}
                  label="悬浮位置"
                  onState="底部"
                  offState="顶部"
                  title="悬浮歌词贴近屏幕的上沿或下沿；自由拖动后下次仍会优先恢复拖动位置。"
                  onChange={() =>
                    setDesktopLyricsPosition(
                      desktopLyricsPosition === "bottom" ? "top" : "bottom",
                    )
                  }
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
                <div className="kd-lyrics-size-row">
                  <span className="kd-djp-toggle-label">
                    {overlayIsNative ? "逐字高亮色" : "歌词颜色"}
                  </span>
                  <input
                    type="color"
                    className="kd-lyrics-color"
                    value={desktopLyricsAccent}
                    aria-label={overlayIsNative ? "悬浮歌词逐字高亮色" : "悬浮歌词颜色"}
                    title={
                      overlayIsNative
                        ? "已唱部分用这个颜色点亮，未唱部分保持半透明白。"
                        : "悬浮歌词主行的文字颜色。"
                    }
                    onChange={(event) => setDesktopLyricsAccent(event.target.value)}
                  />
                </div>
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
