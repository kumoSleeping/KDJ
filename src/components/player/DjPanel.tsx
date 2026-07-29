import { Check } from "lucide-react";
import {
  DJ_BARS_OPTIONS,
  DJ_EFFECTS,
  DJ_TRANSITIONS,
  mixSeconds,
  useDjConfig,
} from "../../lib/djMix";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { Panel, PanelStack } from "../common";

/**
 * 「接播设置」住在右侧详情栏，结构和曲目详情同一套：
 * 每组配置是一块可拖拽排序的 Panel，顺序记在 localStorage。
 */

function formatSeconds(value: number): string {
  return value >= 10 ? `${Math.round(value)} 秒` : `${value.toFixed(1)} 秒`;
}

export function DjPanel() {
  const transitions = useDjConfig((state) => state.transitions);
  const effects = useDjConfig((state) => state.effects);
  const bars = useDjConfig((state) => state.bars);
  const vocalCut = useDjConfig((state) => state.vocalCut);
  const toggleTransition = useDjConfig((state) => state.toggleTransition);
  const toggleEffect = useDjConfig((state) => state.toggleEffect);
  const setBars = useDjConfig((state) => state.setBars);
  const setVocalCut = useDjConfig((state) => state.setVocalCut);

  const selected = useLibraryStore(selectSelectedTrack);
  const bpm = selected?.bpm ?? null;
  const bpmLabel = bpm ? `${Math.round(bpm)} BPM` : "120 BPM（未分析，按默认估）";
  const transitionHint = DJ_TRANSITIONS.filter((item) => transitions.includes(item.id))
    .map((item) => `${item.label}：${item.hint}`)
    .join(" · ");
  const effectHint = DJ_EFFECTS.filter((item) => effects.includes(item.id))
    .map((item) => `${item.label}：${item.hint}`)
    .join(" · ");

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-scroll kd-djp" style={{ minHeight: 0 }}>
        <PanelStack storageKey="kd-dj-panels">
          <Panel key="transitions" heading="接歌方案" dense>
            <div
              className="kd-djp-choices"
              aria-label="接歌方案"
              title={`${transitionHint || "至少选择一种接歌方案"}。每次接歌会从已选方案中随机组合。`}
            >
              {DJ_TRANSITIONS.map((item) => {
                const checked = transitions.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="kd-djp-choice"
                    data-active={checked ? "true" : undefined}
                    onClick={() => toggleTransition(item.id)}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel key="vocal" heading="人声处理" dense>
            <label
              className="kd-djp-check"
              title="保留立体声侧声道和补偿增益，让旧歌人声后退但不突然变小。"
            >
              <span className="kd-djp-check-box" data-on={vocalCut ? "true" : undefined} aria-hidden="true">
                {vocalCut ? <Check size={11} strokeWidth={2.5} /> : null}
              </span>
              <input
                type="checkbox"
                checked={vocalCut}
                onChange={(event) => setVocalCut(event.currentTarget.checked)}
              />
              接歌时渐进削弱上一首的中置人声
            </label>
          </Panel>

          <Panel key="effects" heading="效果器" dense>
            <div
              className="kd-djp-choices"
              aria-label="效果器"
              title={`${effectHint || "未启用效果器"}。强度会在接歌过程中自动推进。`}
            >
              {DJ_EFFECTS.map((item) => {
                const checked = effects.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="kd-djp-choice"
                    data-active={checked ? "true" : undefined}
                    onClick={() => toggleEffect(item.id)}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel key="bars" heading="接歌长度" dense>
            <div
              className="kd-djp-segs"
              role="radiogroup"
              aria-label="接歌长度"
              title={`${bpmLabel} · 约 ${formatSeconds(mixSeconds(bpm, bars))} · 起手点自动按尾段频谱估算`}
            >
              {DJ_BARS_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={value === bars}
                  data-on={value === bars ? "true" : undefined}
                  onClick={() => setBars(value)}
                >
                  {value}
                </button>
              ))}
              <span>小节</span>
            </div>
          </Panel>
        </PanelStack>
      </div>
    </div>
  );
}
