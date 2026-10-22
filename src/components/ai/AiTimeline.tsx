/**
 * A draft's forks (ask_user's `timeline`, src/lib/aiTimeline.ts): the picture the option picked
 * now gives at the focused fork at the top, the draft as lanes under a bar ruler with every fork
 * marked in the middle, the focused fork's options at the bottom. Picking an option changes the
 * picture and the lanes at once; nothing plays.
 */
import { useState } from "react";
import { Check } from "lucide-react";
import { clock, forkStrip, laneView, rulerStep, type AskTimeline } from "../../lib/aiTimeline";
import "./AiTimeline.css";

const MARKS = ["①", "②", "③", "④", "⑤", "⑥"];
const pct = (value: number) => `${Math.max(0, Math.min(100, value * 100))}%`;

/** One picture of the preview: a frame, black where nothing is on screen, a word where there is no moment. */
function Frame({ timeline, at, edge }: { timeline: AskTimeline; at: string | null; edge?: string }) {
  if (at === null) return <span className="kd-ai-tl-frame" data-none="">{edge ?? ""}</span>;
  const src = at ? timeline.frames[at] : undefined;
  if (src) return <span className="kd-ai-tl-frame"><img src={src} alt="" draggable={false} /></span>;
  return <span className="kd-ai-tl-frame" data-black="">{at ? "没截到" : "无画面"}</span>;
}

export function TimelineBoard({ timeline, picks, onPick }: {
  timeline: AskTimeline;
  picks: Readonly<Record<string, string>>;
  onPick(forkId: string, optionId: string): void;
}) {
  const [focus, setFocus] = useState(0);
  // Which of the five pictures is shown large; the middle one inside the fork unless chosen.
  const [shown, setShown] = useState(2);
  const fork = timeline.forks[Math.min(focus, timeline.forks.length - 1)];
  if (!fork) return null;
  const option = fork.options.find(item => item.id === picks[fork.id]) ?? fork.options[0];
  const strip = forkStrip(fork, option);
  const lanes = laneView(timeline, picks);
  const span = Math.max(timeline.duration, 0.001);
  const step = rulerStep(timeline.bars.length);
  const ruler = timeline.bars.filter(bar => (bar.n - 1) % step === 0);
  const pictureLanes = lanes.filter(clips => clips.some(clip => clip.kind !== "audio")).length;
  let pictureNo = 0;
  const laneName = (clips: typeof lanes[number]) => {
    if (clips.length > 0 && clips.every(clip => clip.kind === "audio")) return "声音";
    pictureNo += 1;
    return pictureLanes > 1 ? `画面 ${pictureNo}` : "画面";
  };
  const focusOn = (n: number) => { setFocus(n); setShown(2); };

  return <div className="kd-ai-tl">
    <div className="kd-ai-tl-preview">
      <div className="kd-ai-tl-screen">
        <Frame timeline={timeline} at={strip[shown]?.key ?? null} edge={shown === 0 ? "成片开头" : "成片结尾"} />
        <span className="kd-ai-tl-where">{`${MARKS[focus] ?? ""} ${strip[shown]?.caption ?? ""} · ${option.label}`}</span>
      </div>
      <div className="kd-ai-tl-strip" role="group" aria-label="这一处的画面">
        {strip.map((item, n) => <button key={n} type="button" className="kd-ai-tl-tile" aria-pressed={n === shown}
          onClick={() => setShown(n)}>
          <Frame timeline={timeline} at={item.key} edge={n === 0 ? "开头" : "结尾"} />
          <span className="kd-ai-tl-caption">{item.caption}</span>
        </button>)}
      </div>
    </div>

    {timeline.forks.length > 1 && <div className="kd-ai-ask-row" role="group" aria-label="要定的地方">
      {timeline.forks.map((item, n) => {
        const picked = item.options.find(choice => choice.id === picks[item.id]);
        return <button key={item.id} type="button" className="kd-ai-choice" aria-pressed={n === focus}
          title={item.question} onClick={() => focusOn(n)}>
          {`${MARKS[n] ?? n + 1} ${clock(item.start)} · ${picked?.label ?? ""}`}
        </button>;
      })}
    </div>}

    <div className="kd-ai-tl-board">
      <div className="kd-ai-tl-names" aria-hidden="true">
        <span className="kd-ai-tl-name" data-ruler="">小节</span>
        {lanes.map((clips, n) => <span key={n} className="kd-ai-tl-name">{laneName(clips)}</span>)}
      </div>
      <div className="kd-ai-tl-lanes">
        <div className="kd-ai-tl-ruler">
          {ruler.map(bar => <span key={bar.n} className="kd-ai-tl-bar" style={{ left: pct(bar.at / span) }}>{bar.n}</span>)}
        </div>
        {lanes.map((clips, n) => <div key={n} className="kd-ai-tl-lane">
          {clips.map((clip, j) => <span key={j} className="kd-ai-tl-clip" data-kind={clip.kind} data-filled={clip.filled || undefined}
            title={`${clip.label} · ${clock(clip.at)}–${clock(clip.at + clip.length)}`}
            style={{ left: pct(clip.at / span), width: pct(clip.length / span) }}>{clip.label}</span>)}
        </div>)}
        {timeline.forks.map((item, n) => <button key={item.id} type="button" className="kd-ai-tl-fork" aria-pressed={n === focus}
          aria-label={`${MARKS[n] ?? n + 1} ${item.question}`} onClick={() => focusOn(n)}
          style={{ left: pct(item.start / span), width: pct((item.end - item.start) / span) }}>
          <span className="kd-ai-tl-fork-mark">{MARKS[n] ?? n + 1}</span>
        </button>)}
      </div>
    </div>

    <div className="kd-ai-tl-question">
      <p className="kd-ai-tl-ask">{`${MARKS[focus] ?? ""} ${fork.question}`}</p>
      <span className="kd-ai-tl-span">{`第 ${fork.from_bar}–${fork.to_bar - 1} 小节 · ${clock(fork.start)}–${clock(fork.end)}`}</span>
    </div>
    <div className="kd-ai-tl-options" role="group" aria-label={fork.question}>
      {fork.options.map(item => {
        const on = item.id === option.id;
        return <button key={item.id} type="button" className="kd-ai-tl-option" aria-pressed={on}
          data-default={item.id === fork.default || undefined}
          onClick={() => { onPick(fork.id, item.id); setShown(2); }}>
          <span className="kd-ai-tl-option-label">{on && <Check size={12} aria-hidden="true" />}{item.label}</span>
          {item.note && <span className="kd-ai-tl-option-note">{item.note}</span>}
        </button>;
      })}
    </div>
  </div>;
}
