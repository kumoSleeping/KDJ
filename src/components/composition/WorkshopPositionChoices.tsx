import type { WorkshopPositionAnalysis, WorkshopPositionPreset } from "../../types/workshop";

export function WorkshopPositionChoices({ analysis, sourceTitle, saving, onApply }: {
  analysis: WorkshopPositionAnalysis;
  sourceTitle: string;
  saving: boolean;
  onApply(id: string): void;
}) {
  const groups: { prerequisite: string; presets: WorkshopPositionPreset[] }[] = [];
  for (const preset of analysis.presets) {
    const prerequisite = preset.prerequisite ?? "";
    const last = groups.at(-1);
    if (last?.prerequisite === prerequisite) last.presets.push(preset);
    else groups.push({ prerequisite, presets: [preset] });
  }
  return groups.map(({ prerequisite, presets }) => (
    <div className="vj-position-choice-group" key={presets[0].id} role="group"
      aria-label={prerequisite || "匹配方案"}>
      {prerequisite && <span className="vj-position-prerequisite">{prerequisite}</span>}
      <div className="vj-position-choice-actions">
        {presets.map(preset => {
          const full = preset.id.endsWith("longest");
          const detail = full
            ? "按最长匹配段确定整体位置，保留完整视频；其余内容不保证匹配"
            : preset.id === "fuzzy-speed-sections"
              ? "一次应用全部匹配片段，按音乐顺序拼接；未匹配处留空"
              : "只保留匹配段，裁掉其余内容";
          return <button key={preset.id} type="button" disabled={saving}
            aria-label={`${sourceTitle}：${prerequisite ? `${prerequisite}，` : ""}${preset.label}`}
            aria-pressed={analysis.applied === preset.id}
            title={`${analysis.reference_title}；${prerequisite ? `${prerequisite}，` : ""}${preset.id.startsWith("review-melody-") ? "旋律对应候选，尚未通过严格录音匹配；" : ""}${detail}`}
            onClick={() => onApply(preset.id)}>
            {preset.label}{!full && preset.placements.length > 1 ? ` · ${preset.placements.length} 段` : ""}
          </button>;
        })}
      </div>
    </div>
  ));
}
