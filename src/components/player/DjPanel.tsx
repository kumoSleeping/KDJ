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
 * 「接播设置」面板，住在右侧详情栏里，由播放条的 DJ 按钮呼出。
 *
 * 为什么不是弹窗：配置项有多组，弹窗装下这些
 * 就成了一个挡在列表前面的小窗口；详情栏本来就是"当前关注的东西"待的位置，
 * 账号管理也是这么住进来的。改完不用点保存——每一下都即时生效并落盘。
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

  // 秒数估算用选中曲的 BPM——播放时详情跟着正在放的那首走（PlayerBar 会
  // selectTrack），所以它几乎总是"当前这首"的速度；没分析过就按 120 估。
  const selected = useLibraryStore(selectSelectedTrack);
  const bpm = selected?.bpm ?? null;
  const bpmLabel = bpm ? `${Math.round(bpm)} BPM` : "120 BPM（未分析，按默认估）";

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-toolbar">
        <strong>接播设置</strong>
      </div>

      <div className="kd-scroll kd-djp" style={{ minHeight: 0 }}>
        <PanelStack storageKey="kd-dj-panels-v3">
        <Panel key="preset" heading="接歌方案" padded dense>
          <p className="kd-djp-intro">
            勾选多个后，每次接歌会从中随机取至少一个叠加组合。下一首先同步 BPM，
            按本场抽到的曲线交接，结束后再缓慢回到原速。
          </p>
          <div className="kd-djp-options" aria-label="接歌方案">
            {DJ_TRANSITIONS.map((item) => {
              const checked = transitions.includes(item.id);
              return (
              <button
                key={item.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                className="kd-djp-option"
                data-active={checked ? "true" : undefined}
                onClick={() => toggleTransition(item.id)}
              >
                <span className="kd-djp-dot" aria-hidden="true" />
                <span className="kd-djp-text">
                  <span className="kd-djp-label">{item.label}</span>
                  <span className="kd-djp-hint">{item.hint}</span>
                </span>
              </button>
              );
            })}
          </div>
        </Panel>

        <Panel key="vocal" heading="人声处理" padded dense>
          <label className="kd-djp-check">
            <input
              type="checkbox"
              checked={vocalCut}
              onChange={(event) => setVocalCut(event.currentTarget.checked)}
            />
            接歌时渐进削弱上一首的中置人声
          </label>
          <p className="kd-djp-note">
            使用部分 Mid/Side 削弱，不再把原声完全切成 L−R。旧歌人声会退到后面，
            但仍保留一半以上原声、立体声侧声道和补偿增益，避免整体突然变小。
          </p>
        </Panel>

        <Panel key="effects" heading="效果器" padded dense>
          <p className="kd-djp-intro">
            可同时勾选，接歌起手时读取当前配置；干湿比会按小节自动推进，越接近结尾效果越强。
          </p>
          <div className="kd-djp-options" aria-label="效果器">
            {DJ_EFFECTS.map((item) => {
              const checked = effects.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  className="kd-djp-option"
                  data-active={checked ? "true" : undefined}
                  onClick={() => toggleEffect(item.id)}
                >
                  <span className="kd-djp-dot" aria-hidden="true" />
                  <span className="kd-djp-text">
                    <span className="kd-djp-label">{item.label}</span>
                    <span className="kd-djp-hint">{item.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel key="length" heading="接歌长度" padded dense>
          <div className="kd-djp-segs" role="radiogroup" aria-label="接歌长度">
            {DJ_BARS_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === bars}
                data-on={value === bars ? "true" : undefined}
                onClick={() => setBars(value)}
              >
                {value} 小节
              </button>
            ))}
          </div>
          <p className="kd-djp-note">
            按 {bpmLabel}，{bars} 小节 ≈ {formatSeconds(mixSeconds(bpm, bars))}。
            小节按 4/4 拍算，以正在放的那首为准；起手点自动按尾段频谱估算。
          </p>
        </Panel>
        </PanelStack>
      </div>
    </div>
  );
}
