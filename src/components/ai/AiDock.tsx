/**
 * The AI corner (docs/ai-dock.md): a surface at the bottom right, where the task bubbles rest,
 * that holds one conversation with pi. Each tool pi calls is a step drawn as it runs
 * (AiSteps.tsx). The bubbles make room for it (src/lib/aiDockPlace.ts): to its left in a wide
 * window — with the player bar put away, the playing song's bubble is pushed left and the dock
 * takes the corner — or on top of it in a narrow one.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, ChevronsDown, LoaderCircle, Settings2, Square, SquarePen } from "lucide-react";
import { setAiDockPlace } from "../../lib/aiDockPlace";
import { motion } from "../../lib/motion";
import { playerBarStandsDown, usePlayerBarAway } from "../../lib/playerBarAway";
import { usePlayerBarHeight } from "../../lib/playerBarHeight";
import { openAiSettings } from "../../lib/aiSettings";
import { useAiStore } from "../../stores/aiStore";
import type { AiAskPart, AiPart, AiStatus } from "../../types/ai";
import { AiStep } from "./AiSteps";
import "./AiDock.css";

/** The gap to the window's edge and to the bar: the bottom stack's (--kd-task-gap). */
const EDGE_GAP = 12;
/** The width a regular task bubble needs beside the dock: 24rem and its gap. */
const BESIDE_ROOM = 24 * 16 + 2 * EDGE_GAP;
/** How close to the end of the log still counts as following it. */
const FOLLOW_SLACK = 48;

/** What stands in the way of a conversation, as state: no pi, a pi that does not run, no model. */
function blocker(status: AiStatus | null, statusError: string): string | null {
  if (statusError) return statusError;
  if (!status) return null;
  if (status.pi.state === "missing") return "未安装 pi";
  if (status.pi.state === "broken") return status.pi.error ? `pi 无法运行：${status.pi.error}` : "pi 无法运行";
  if (!status.provider || !status.providers.some(provider => provider.id === status.provider && provider.configured)) return "未设置模型";
  return null;
}

function modelLabel(status: AiStatus | null): string {
  if (!status?.provider) return "";
  const provider = status.providers.find(item => item.id === status.provider)?.label ?? status.provider;
  return status.model ? `${provider} · ${status.model}` : provider;
}

function AskView({ part }: { part: AiAskPart }) {
  const answer = useAiStore(state => state.answer);
  const [value, setValue] = useState(part.placeholder ?? "");
  const answered = part.answer !== undefined;
  return <div className="kd-ai-ask" data-answered={answered || undefined}>
    <span className="kd-ai-ask-title">{part.title}</span>
    {part.message && <span className="kd-ai-ask-message">{part.message}</span>}
    {answered
      ? <span className="kd-ai-ask-answer">{part.answer === null ? "已取消" : part.answer === true ? "确定" : part.answer === false ? "取消" : part.answer}</span>
      : <div className="kd-ai-ask-keys">
        {part.method === "select" && part.options?.map(option =>
          <button key={option} type="button" className="kd-ai-choice" onClick={() => void answer(part.id, option)}>{option}</button>)}
        {part.method === "confirm" && <>
          <button type="button" className="kd-ai-choice" onClick={() => void answer(part.id, true)}>确定</button>
          <button type="button" className="kd-ai-choice" onClick={() => void answer(part.id, false)}>取消</button>
        </>}
        {part.method === "input" && <form className="kd-ai-ask-form" onSubmit={event => { event.preventDefault(); void answer(part.id, value); }}>
          <input className="kd-ai-ask-input" value={value} onChange={event => setValue(event.target.value)} aria-label={part.title} />
          <button type="submit" className="kd-ai-choice">确定</button>
        </form>}
        {part.method !== "confirm" && <button type="button" className="kd-ai-choice" data-quiet="true" onClick={() => void answer(part.id, null)}>取消</button>}
      </div>}
  </div>;
}

function PartView({ part }: { part: AiPart }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  switch (part.kind) {
    case "user":
      return <p className="kd-ai-user">{part.text}</p>;
    case "text":
      return part.text ? <p className="kd-ai-text" data-streaming={part.streaming || undefined}>{part.text}</p> : null;
    case "thinking":
      return part.text ? <button type="button" className="kd-ai-thinking" aria-expanded={thinkingOpen} onClick={() => setThinkingOpen(!thinkingOpen)}>
        <span className="kd-ai-thinking-label">{part.streaming ? "思考中" : "思考"}</span>
        {thinkingOpen && <span className="kd-ai-thinking-text">{part.text}</span>}
      </button> : null;
    case "tool":
      return <AiStep step={part} />;
    case "ask":
      return <AskView part={part} />;
    case "note":
      return <p className="kd-ai-note" data-tone={part.tone}>{part.text}</p>;
  }
}

function Composer({ disabled }: { disabled: boolean }) {
  const running = useAiStore(state => state.running);
  const send = useAiStore(state => state.send);
  const abort = useAiStore(state => state.abort);
  const seed = useAiStore(state => state.seed);
  const [draft, setDraft] = useState(seed?.text ?? "");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    useAiStore.setState({ seed: null });
    field.current?.focus();
  }, [seed]);
  useEffect(() => { if (!disabled) field.current?.focus(); }, [disabled]);
  // The field grows with what is written, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  const submit = () => {
    if (!draft.trim() || disabled) return;
    void send(draft);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  // While pi works, a line that is sent steers it; with nothing written the key stops it.
  const stop = running && !draft.trim();
  return <form className="kd-ai-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
    <textarea ref={field} className="kd-ai-field" rows={1} value={draft} disabled={disabled} aria-label="发给 AI"
      onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
    {stop
      ? <button type="button" className="kd-ai-key kd-ai-send" aria-label="停止" title="停止" onClick={() => void abort()}>
        <Square size={12} fill="currentColor" aria-hidden="true" />
      </button>
      : <button type="submit" className="kd-ai-key kd-ai-send" aria-label="发送" title="发送（Enter）" disabled={disabled || !draft.trim()}>
        <ArrowUp size={15} aria-hidden="true" />
      </button>}
  </form>;
}

function AiDockSurface({ root }: { root: HTMLElement }) {
  const status = useAiStore(state => state.status);
  const statusError = useAiStore(state => state.statusError);
  const parts = useAiStore(state => state.parts);
  const running = useAiStore(state => state.running);
  const setOpen = useAiStore(state => state.setOpen);
  const reset = useAiStore(state => state.reset);

  // The dock stands on the bar and goes down with it when the bar is put away, on the bar's own
  // clocks (--kd-ai-floor, as `translate`, so the arriving gesture's transform is left alone).
  const barHeight = usePlayerBarHeight(root);
  const barPhase = usePlayerBarAway(state => state.phase);
  const floor = playerBarStandsDown(barPhase) ? 0 : barHeight;

  // Its size, for the bubbles that make room for it. Measured as laid out, not as it moves.
  const node = useRef<HTMLElement | null>(null);
  const slide = motion("slide", { edge: "bottom" });
  const slideRef = slide.ref;
  const setNode = useCallback((element: HTMLElement | null) => {
    node.current = element;
    return slideRef(element);
  }, [slideRef]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const measure = () => {
      const width = element.offsetWidth, height = element.offsetHeight;
      setAiDockPlace({ width, height, beside: document.documentElement.clientWidth >= width + 2 * EDGE_GAP + BESIDE_ROOM });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); setAiDockPlace(null); };
  }, []);

  // The log follows what arrives while it is read at its end.
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [parts]);

  const blocked = blocker(status, statusError);
  const label = modelLabel(status);
  const update = status?.pi.latest && status.pi.version ? `pi ${status.pi.latest} 可更新` : "";
  const openSettings = openAiSettings;
  return <section ref={setNode} className="kd-ai-dock" aria-label="AI" data-running={running || undefined} data-bar={barPhase}
    data-kd-motion={slide["data-kd-motion"]} data-kd-edge={slide["data-kd-edge"]}
    style={{ "--kd-ai-floor": `${floor}px` } as CSSProperties}>
    <header className="kd-ai-head">
      <span className="kd-ai-name">AI</span>
      {running && <LoaderCircle size={12} className="kd-spin kd-ai-busy" aria-label="进行中" />}
      <span className="kd-ai-model" title={label}>{label}</span>
      {update && <button type="button" className="kd-ai-update" onClick={openSettings}>{update}</button>}
      <span className="kd-ai-keys">
        {parts.length > 0 && <button type="button" className="kd-ai-key" aria-label="新对话" title="新对话" onClick={() => void reset()}>
          <SquarePen size={14} aria-hidden="true" />
        </button>}
        <button type="button" className="kd-ai-key" aria-label="AI 设置" title="AI 设置" onClick={openSettings}>
          <Settings2 size={14} aria-hidden="true" />
        </button>
        <button type="button" className="kd-ai-key" aria-label="收起" title="收起" onClick={() => setOpen(false)}>
          <ChevronsDown size={14} aria-hidden="true" />
        </button>
      </span>
    </header>
    {parts.length > 0 && <div ref={log} className="kd-ai-log kd-scroll" aria-live="polite"
      onScroll={event => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK;
      }}>
      {parts.map(part => <PartView key={part.id} part={part} />)}
    </div>}
    {blocked
      ? <p className="kd-ai-blocked">
        <span>{blocked}</span>
        <button type="button" className="kd-ai-choice" onClick={openSettings}>设置</button>
      </p>
      : <Composer disabled={!status} />}
  </section>;
}

/** Mounted once per main window, next to the task bubbles. */
export function AiDock() {
  const open = useAiStore(state => state.open);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setRoot(document.querySelector<HTMLElement>(".kd-app")); }, []);
  if (!open || !root) return null;
  return createPortal(<AiDockSurface root={root} />, root);
}
