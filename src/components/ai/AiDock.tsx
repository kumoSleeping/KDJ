/**
 * The AI corner (docs/ai-dock.md): a small chat window at the bottom right that holds one
 * conversation with pi — the listener's lines, the model's replies and its thinking as they
 * stream, and a card for each tool it calls (AiSteps.tsx). Earlier conversations are pi's own
 * sessions and can be resumed from the history.
 *
 * It stands on the player bar. With the bar put away it stands on the playing song's bubble,
 * which keeps the corner, and follows it as it grows or folds (src/lib/aiDockPlace.ts); with the
 * bar up the song's bubble does not come up while the window is open. Other bubbles move to its
 * left.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, ChevronLeft, ChevronsDown, History, LoaderCircle, Settings2, Square, SquarePen } from "lucide-react";
import { setAiDockPlace, useAiDockPlace } from "../../lib/aiDockPlace";
import { openAiSettings } from "../../lib/aiSettings";
import { motion } from "../../lib/motion";
import { playerBarStandsDown, usePlayerBarAway } from "../../lib/playerBarAway";
import { usePlayerBarHeight } from "../../lib/playerBarHeight";
import { useAiStore } from "../../stores/aiStore";
import type { AiAskPart, AiPart, AiSession, AiStatus } from "../../types/ai";
import { AiMarkdown } from "./AiMarkdown";
import { AiStep } from "./AiSteps";
import "./AiDock.css";

/** The gap to the window's edge and to the bar: the bottom stack's (--kd-task-gap). */
const EDGE_GAP = 12;
/** The width a regular task bubble needs beside the window: 24rem and its gap. */
const BESIDE_ROOM = 24 * 16 + 2 * EDGE_GAP;
/** How close to the end of the log still counts as following it. */
const FOLLOW_SLACK = 64;

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

function when(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms), now = new Date();
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function AskView({ part }: { part: AiAskPart }) {
  const answer = useAiStore(state => state.answer);
  const [value, setValue] = useState(part.placeholder ?? "");
  const answered = part.answer !== undefined;
  return <div className="kd-ai-ask" data-answered={answered || undefined} data-kd-motion="fade">
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

/** The model's thinking: written out as it streams, folded to one line when it is done. */
function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = streaming || open;
  return <div className="kd-ai-thinking" data-streaming={streaming || undefined} data-kd-motion="fade">
    <button type="button" className="kd-ai-thinking-head" aria-expanded={shown} disabled={streaming} onClick={() => setOpen(!open)}>
      {streaming ? "思考中" : "思考过程"}
    </button>
    {/* While it streams, the newest lines stay in view at the foot of a short window. */}
    {shown && <div className="kd-ai-thinking-text"><span>{text}</span></div>}
  </div>;
}

function PartView({ part }: { part: AiPart }) {
  switch (part.kind) {
    case "user":
      return <div className="kd-ai-msg" data-role="user" data-kd-motion="fade"><p className="kd-ai-bubble">{part.text}</p></div>;
    case "text":
      return part.text ? <div className="kd-ai-msg kd-ai-reply" data-role="assistant" data-streaming={part.streaming || undefined}>
        <AiMarkdown text={part.text} />
      </div> : null;
    case "thinking":
      return part.text ? <Thinking text={part.text} streaming={part.streaming} /> : null;
    case "tool":
      return <AiStep step={part} />;
    case "ask":
      return <AskView part={part} />;
    case "note":
      return <p className="kd-ai-note" data-tone={part.tone} data-kd-motion="fade">{part.text}</p>;
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
        <Square size={11} fill="currentColor" aria-hidden="true" />
      </button>
      : <button type="submit" className="kd-ai-key kd-ai-send" data-ready={!!draft.trim() || undefined} aria-label="发送" title="发送（Enter）"
        disabled={disabled || !draft.trim()}>
        <ArrowUp size={15} aria-hidden="true" />
      </button>}
  </form>;
}

function HistoryView() {
  const sessions = useAiStore(state => state.sessions);
  const openSession = useAiStore(state => state.openSession);
  const [opening, setOpening] = useState("");
  if (sessions === null) return <div className="kd-ai-log kd-ai-history" aria-busy="true"><LoaderCircle size={16} className="kd-spin" aria-label="读取中" /></div>;
  return <ul className="kd-ai-log kd-ai-history" data-kd-motion="fade">
    {sessions.map((session: AiSession) => <li key={session.path}>
      <button type="button" className="kd-ai-session" disabled={!!opening} aria-busy={opening === session.path || undefined}
        onClick={() => { setOpening(session.path); void openSession(session).finally(() => setOpening("")); }}>
        <span className="kd-ai-session-title">{session.title}</span>
        <span className="kd-ai-session-facts">{when(session.updated)} · {session.messages} 条</span>
        {opening === session.path && <LoaderCircle size={13} className="kd-spin" aria-hidden="true" />}
      </button>
    </li>)}
  </ul>;
}

function ChatLog() {
  const parts = useAiStore(state => state.parts);
  // The log follows what arrives while it is read at its end.
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [parts]);
  // A card that grows by itself (rows arriving, a download's tasks) keeps the end in view too.
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const keep = new ResizeObserver(() => { if (following.current) element.scrollTop = element.scrollHeight; });
    for (const child of Array.from(element.children)) keep.observe(child);
    return () => keep.disconnect();
  }, [parts]);
  return <div ref={log} className="kd-ai-log kd-scroll" aria-live="polite"
    onScroll={event => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK;
    }}>
    {parts.map(part => <PartView key={part.id} part={part} />)}
  </div>;
}

function AiDockSurface({ root }: { root: HTMLElement }) {
  const status = useAiStore(state => state.status);
  const statusError = useAiStore(state => state.statusError);
  const parts = useAiStore(state => state.parts);
  const running = useAiStore(state => state.running);
  const view = useAiStore(state => state.view);
  const title = useAiStore(state => state.title);
  const setOpen = useAiStore(state => state.setOpen);
  const setView = useAiStore(state => state.setView);
  const reset = useAiStore(state => state.reset);

  // It stands on the bar, and with the bar away on the playing song's bubble; it moves with
  // either on their own clocks (--kd-ai-floor as `translate`, which leaves the arriving gesture's
  // transform alone).
  const barHeight = usePlayerBarHeight(root);
  const barPhase = usePlayerBarAway(state => state.phase);
  const under = useAiDockPlace(state => state.under);
  const floor = (playerBarStandsDown(barPhase) ? 0 : barHeight) + under;

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

  const blocked = blocker(status, statusError);
  const label = modelLabel(status);
  const update = status?.pi.latest && status.pi.version ? `pi ${status.pi.latest} 可更新` : "";
  const history = view === "history";
  return <section ref={setNode} className="kd-ai-dock" aria-label="AI" data-running={running || undefined} data-bar={barPhase}
    data-kd-motion={slide["data-kd-motion"]} data-kd-edge={slide["data-kd-edge"]}
    style={{ "--kd-ai-floor": `${floor}px` } as CSSProperties}>
    <header className="kd-ai-head">
      {history && <button type="button" className="kd-ai-key" aria-label="返回对话" title="返回对话" onClick={() => setView("chat")}>
        <ChevronLeft size={15} aria-hidden="true" />
      </button>}
      <span className="kd-ai-heading">
        <span className="kd-ai-name" title={history ? undefined : title || undefined}>{history ? "历史对话" : title || "AI"}</span>
        {!history && (label || update) && <span className="kd-ai-model">
          {label && <span title={label}>{label}</span>}
          {update && <button type="button" className="kd-ai-update" onClick={openAiSettings}>{update}</button>}
        </span>}
      </span>
      {running && <LoaderCircle size={13} className="kd-spin kd-ai-busy" aria-label="进行中" />}
      <span className="kd-ai-keys">
        {!history && <button type="button" className="kd-ai-key" aria-label="历史对话" title="历史对话" onClick={() => setView("history")}>
          <History size={15} aria-hidden="true" />
        </button>}
        {(parts.length > 0 || history) && <button type="button" className="kd-ai-key" aria-label="新对话" title="新对话" onClick={() => void reset()}>
          <SquarePen size={15} aria-hidden="true" />
        </button>}
        <button type="button" className="kd-ai-key" aria-label="AI 设置" title="AI 设置" onClick={openAiSettings}>
          <Settings2 size={15} aria-hidden="true" />
        </button>
        <button type="button" className="kd-ai-key" aria-label="收起" title="收起" onClick={() => setOpen(false)}>
          <ChevronsDown size={15} aria-hidden="true" />
        </button>
      </span>
    </header>
    {history ? <HistoryView /> : <ChatLog />}
    {!history && (blocked
      ? <p className="kd-ai-blocked">
        <span>{blocked}</span>
        <button type="button" className="kd-ai-choice" onClick={openAiSettings}>设置</button>
      </p>
      : <Composer disabled={!status} />)}
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
