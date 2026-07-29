import { useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  DJ_BARS_OPTIONS,
  DJ_EFFECTS,
  DJ_TRANSITIONS,
  mixSeconds,
  useDjConfig,
} from "../../lib/djMix";
import {
  useTrackClickPrefs,
} from "../../lib/trackClickPrefs";
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
      <span className="kd-djp-toggle-state" aria-hidden="true">
        {checked ? onState : offState}
      </span>
    </button>
  );
}

/** 离散档位滑条：指针拖动，避开原生 range 在 Tauri 里拖不动的问题。 */
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

  const pick = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const next = DJ_BARS_OPTIONS[Math.round(t * max)];
    if (next != null) onChange(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pick(event.clientX);
  };

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
            onPointerDown={onPointerDown}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              pick(event.clientX);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
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

export function SettingsPanel() {
  const theme = useAppStore((state) => state.settings?.theme ?? "system");
  const saveSettings = useAppStore((state) => state.saveSettings);
  const transitions = useDjConfig((state) => state.transitions);
  const effects = useDjConfig((state) => state.effects);
  const bars = useDjConfig((state) => state.bars);
  const vocalCut = useDjConfig((state) => state.vocalCut);
  const toggleTransition = useDjConfig((state) => state.toggleTransition);
  const toggleEffect = useDjConfig((state) => state.toggleEffect);
  const setBars = useDjConfig((state) => state.setBars);
  const setVocalCut = useDjConfig((state) => state.setVocalCut);

  const widePlay = useTrackClickPrefs((state) => state.widePlay);
  const narrowPlay = useTrackClickPrefs((state) => state.narrowPlay);
  const clickAddNext = useTrackClickPrefs((state) => state.clickAddNext);
  const setWidePlay = useTrackClickPrefs((state) => state.setWidePlay);
  const setNarrowPlay = useTrackClickPrefs((state) => state.setNarrowPlay);
  const setClickAddNext = useTrackClickPrefs((state) => state.setClickAddNext);
  const addNextAvailable = widePlay === "double" || narrowPlay === "double";

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
    updateSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
