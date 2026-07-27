import {
  DJ_BARS_OPTIONS,
  DJ_EFFECTS,
  DJ_TRANSITIONS,
  mixSeconds,
  useDjConfig,
} from "../../lib/djMix";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";

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
  const transitionHint = DJ_TRANSITIONS.filter((item) => transitions.includes(item.id))
    .map((item) => `${item.label}：${item.hint}`)
    .join(" · ");
  const effectHint = DJ_EFFECTS.filter((item) => effects.includes(item.id))
    .map((item) => `${item.label}：${item.hint}`)
    .join(" · ");

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-toolbar">
        <strong>接播设置</strong>
      </div>

      <div className="kd-scroll kd-djp" style={{ minHeight: 0 }}>
        <section className="kd-djp-section">
          <h3>接歌方案</h3>
          <div className="kd-djp-choices" aria-label="接歌方案">
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
                  <span className="kd-djp-choice-mark" aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </div>
          <p className="kd-djp-note">
            {transitionHint || "至少选择一种接歌方案"}。每次接歌会从已选方案中随机组合。
          </p>
        </section>

        <section className="kd-djp-section">
          <h3>人声处理</h3>
          <label className="kd-djp-check">
            <input
              type="checkbox"
              checked={vocalCut}
              onChange={(event) => setVocalCut(event.currentTarget.checked)}
            />
            接歌时渐进削弱上一首的中置人声
          </label>
          <p className="kd-djp-note">
            保留立体声侧声道和补偿增益，让旧歌人声后退但不突然变小。
          </p>
        </section>

        <section className="kd-djp-section">
          <h3>效果器</h3>
          <div className="kd-djp-choices" aria-label="效果器">
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
                  <span className="kd-djp-choice-mark" aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </div>
          <p className="kd-djp-note">
            {effectHint || "未启用效果器"}。强度会在接歌过程中自动推进。
          </p>
        </section>

        <section className="kd-djp-section">
          <h3>接歌长度</h3>
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
                {value}
              </button>
            ))}
            <span>小节</span>
          </div>
          <p className="kd-djp-note">
            {bpmLabel} · 约 {formatSeconds(mixSeconds(bpm, bars))} · 起手点自动按尾段频谱估算
          </p>
        </section>
      </div>
    </div>
  );
}
