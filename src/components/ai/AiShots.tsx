import { useState } from "react";
import type { AiShot } from "../../lib/aiShots";
import "./AiShots.css";

/**
 * The frames the AI cut (aiShots.ts), as a row of small pictures with the moment under each; a
 * click opens one across the row, another click (or the open one again) closes it. Shown in the
 * step bubble at the top and under the step in the task's record.
 */
export function AiShots({ shots, more = 0 }: { shots: readonly AiShot[]; more?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  if (shots.length === 0) return null;
  const opened = open !== null ? shots[open] : undefined;
  return <div className="kd-ai-shots" aria-label="截取的画面">
    {opened && <button type="button" className="kd-ai-shot-open" title="收起" aria-label="收起大图" onClick={() => setOpen(null)}>
      <img src={opened.src} alt={opened.label} draggable={false} />
    </button>}
    <div className="kd-ai-shot-row">
      {shots.map((shot, index) => <button key={index} type="button" className="kd-ai-shot" aria-pressed={open === index}
        title={shot.label ? `${shot.label} · 点击放大` : "点击放大"} onClick={() => setOpen(open === index ? null : index)}>
        <img src={shot.src} alt={shot.label} draggable={false} />
        {shot.label && <span className="kd-ai-shot-label">{shot.label}</span>}
      </button>)}
      {more > 0 && <span className="kd-ai-shot-more">+{more}</span>}
    </div>
  </div>;
}
