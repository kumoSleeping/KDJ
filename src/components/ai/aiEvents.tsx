/**
 * pi's stream turned into what the window does (docs/ai-dock.md). The AI writes nothing back:
 *
 * - each tool call is a bubble at the top while it runs and for a moment after (aiTasks.ts says
 *   what it reads); downloads report in the download list and its bubbles like any other;
 * - `kdj_search` runs the same search in the search pane, `kdj_library_list` the same lookup in
 *   the library, `kdj_play` plays the track; when the task is done and the listener has not
 *   moved the window, it goes back to where they were (aiPlace.ts);
 * - `ask_user` is a bubble at the bottom right: the question, songs as cards (cover, title,
 *   artists, where they come from) and/or text choices, one or several to pick, a line for the
 *   listener's own words, and when the AI gave one, a countdown after which its default is taken;
 * - `tell_user` is a message at the top that stays as long as the AI said, or until put away;
 * - the listener's own request is a task at the bottom right, over the playing song's bubble: it
 *   has no countdown and leaves when the AI is done. A line sent while it works is a second task
 *   until the AI takes it in, then joins the first as a supplement. A task the AI has not taken
 *   yet can be taken back;
 * - what goes wrong is an amber bubble at the top.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, FileVideo, Globe, Library, LoaderCircle, LogIn, Search, Settings2, Sparkles, Square, Undo2, Wrench } from "lucide-react";
import { aiApi } from "../../lib/api";
import { requestAiLibrary, requestAiSearch } from "../../lib/aiSearch";
import { aiTaskBegan, aiTaskEnded } from "../../lib/aiPlace";
import { openAiSettings } from "../../lib/aiSettings";
import { noticeOnEnd, noticeOnStart, resultText, stepProgress, type AiNotice, type AiNoticeIcon } from "../../lib/aiTasks";
import { formatDuration, thumbUrl } from "../../lib/format";
import type { PiEvent } from "../../types/ai";
import type { Platform } from "../../types";
import { VinylPlaceholder } from "../common/VinylPlaceholder";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";
import { dismissTask, showTask, updateTask } from "../tasks/taskBubbleStore";
import { emptyTrace, reduceAiTrace } from "../../lib/aiTrace";
import { AiTaskTrace } from "./AiTaskTrace";
import { useAiStore, type AiRun } from "../../stores/aiStore";
import { PlanBody, PlanText, type PlanMedia } from "./AiMarkup";
import "./AiAsk.css";

/**
 * How long a running step may stay up. It is timed rather than kept, so that when a place is
 * full the oldest notices make room for the newest (TASK_VISIBLE_LIMIT).
 */
const RUNNING_STAY_MS = 5 * 60_000;
/** A message this short is the bubble's title; a longer one is its text. */
const SHORT_MESSAGE = 36;

const ICONS: Record<AiNoticeIcon, ReactNode> = {
  search: <Search size={16} aria-hidden="true" />,
  web: <Globe size={16} aria-hidden="true" />,
  login: <LogIn size={16} aria-hidden="true" />,
  library: <Library size={16} aria-hidden="true" />,
  video: <FileVideo size={16} aria-hidden="true" />,
  tool: <Wrench size={16} aria-hidden="true" />,
};
const AI_MARK = <Sparkles size={16} aria-hidden="true" />;

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => (value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * The searches the AI starts together (one turn calls several at once) are shown as one: their
 * keywords, one per line, run as a single search, whose answers the pane interleaves.
 */
const SEARCH_GATHER_MS = 200;
let gathered: Fields[] = [];
let gatherTimer: ReturnType<typeof setTimeout> | null = null;
function gatherSearch(args: Fields) {
  gathered.push(args);
  if (gatherTimer) return;
  gatherTimer = setTimeout(() => {
    const searches = gathered;
    gathered = [];
    gatherTimer = null;
    const texts = [...new Set(searches.map(search => str(search.text).trim()).filter(Boolean))];
    const same = (key: string) => searches.every(search => JSON.stringify(search[key] ?? null) === JSON.stringify(searches[0][key] ?? null));
    requestAiSearch({
      text: texts.join("\n"),
      kind: same("kind") ? searches[0].kind : undefined,
      platforms: same("platforms") ? searches[0].platforms : undefined,
    });
  }, SEARCH_GATHER_MS);
}

/** The calls under way: their tool and arguments, for the line their end writes. */
const calls = new Map<string, { tool: string; args: Fields }>();
/** The step bubbles this task put up at the top, cleared when its closing words come. */
const stepBubbles = new Set<string>();
/** The AI's last words in this task: its closing reply. */
let lastReply = "";

function noticeBubble(id: string, notice: AiNotice, stay: number | undefined, progress?: number) {
  stepBubbles.add(id);
  showTask({
    progress,
    id: `ai:${id}`,
    kind: "ai",
    title: notice.title,
    detail: notice.detail,
    icon: ICONS[notice.icon],
    tone: notice.tone,
    placement: "top",
    size: notice.detail ? "regular" : "small",
    stay,
  });
}

/** One sentence at the top, for the AI's own troubles. */
export function aiProblem(message: string, actions?: Parameters<typeof showTask>[0]["actions"]) {
  showTask({ id: "ai:problem", kind: "ai", title: message, icon: AI_MARK, tone: "error", placement: "top", actions });
}

/** No pi, or no model: said where the request was made, with the way to set it up. */
export function aiBlocked(message: string) {
  aiProblem(message, [{ id: "ai-settings", label: "AI 设置", icon: <Settings2 size={14} aria-hidden="true" />, onSelect: openAiSettings }]);
}

function answer(id: string, body: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
  void aiApi.answer({ id, ...body }).catch(() => undefined);
}

// ---------------------------------------------------------------- ask_user

interface AskSong { ref: string; title: string; artists: string[]; platform: string; cover: string; duration: number | null }
interface AskQuestion { id: string; question: string; options: string[]; multiple: boolean; defaults: string[] }
interface Asked {
  question: string; body: string; preview: string; questions: AskQuestion[];
  media: Record<string, PlanMedia>; shots: Record<string, string>;
  options: string[]; songs: AskSong[]; multiple: boolean; defaults: string[]; timeout: number;
}

/** The dialog each `ask_user` call waits on (`kdj:ask:<call id>`), and an answer given before it came. */
const askDialogs = new Map<string, string>();
const askEarly = new Map<string, string>();

function sendAsk(callId: string, reply: { choices?: string[]; answers?: Record<string, string[]>; note?: string; cancelled?: boolean }) {
  const value = JSON.stringify(reply);
  const dialog = askDialogs.get(callId);
  if (dialog) answer(dialog, { value });
  else askEarly.set(callId, value);
}

function asked(details: unknown): Asked {
  const data = fields(details);
  return {
    question: str(data.question),
    body: str(data.body),
    preview: str(data.preview),
    media: Object.fromEntries(Object.entries(fields(data.media)).map(([ref, raw]) => {
      const item = fields(raw);
      return [ref, { ref, title: str(item.title) || ref, artists: strings(item.artists), platform: str(item.platform),
        cover: str(item.cover), duration: typeof item.duration === "number" ? item.duration : null, kind: str(item.kind) }];
    })),
    shots: Object.fromEntries(Object.entries(fields(data.shots)).filter(([, src]) => typeof src === "string" && src.startsWith("data:image/"))
      .map(([path, src]) => [path, src as string])),
    questions: (Array.isArray(data.questions) ? data.questions : []).map(raw => {
      const item = fields(raw);
      return { id: str(item.id), question: str(item.question), options: strings(item.options),
        multiple: item.multiple === true, defaults: strings(item.defaults) };
    }).filter(item => item.id && (item.options.length > 0 || str(data.body) !== "")),
    options: strings(data.options),
    songs: (Array.isArray(data.songs) ? data.songs : []).map(raw => {
      const song = fields(raw);
      return { ref: str(song.ref), title: str(song.title) || str(song.ref), artists: strings(song.artists),
        platform: str(song.platform), cover: str(song.cover), duration: typeof song.duration === "number" ? song.duration : null };
    }).filter(song => song.ref),
    multiple: data.multiple === true,
    defaults: strings(data.defaults),
    timeout: typeof data.timeout === "number" ? data.timeout : 0,
  };
}

function SongCover({ song }: { song: AskSong }) {
  const [failed, setFailed] = useState(false);
  return <span className="kd-ai-song-cover">
    {song.cover && !failed
      ? <img src={thumbUrl(song.cover, 96)} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <VinylPlaceholder />}
  </span>;
}

/**
 * The listener's own words under a question: a field that grows with what is written (up to a few
 * lines), Enter sends, Shift + Enter breaks the line; 暂停 and 确定 beside it.
 */
function NoteField({ note, onNote, canSend, onPause }: { note: string; onNote(text: string): void; canSend: boolean; onPause(): void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 96)}px`;
  }, [note]);
  return <div className="kd-ai-note">
    <textarea ref={field} className="kd-ai-note-field" rows={1} value={note} placeholder="补充（可选）" aria-label="补充说明"
      onChange={event => onNote(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && canSend) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    <span className="kd-ai-note-keys">
      <button type="button" className="kd-ai-note-key" data-quiet="" title="停下这次任务" onClick={onPause}>暂停</button>
      <button type="submit" className="kd-ai-note-key" data-send="" disabled={!canSend}>确定</button>
    </span>
  </div>;
}

/**
 * Several questions answered together (a plan): what the AI means to do, written in Markdown
 * with its keys, material cards and evidence frames in it (AiMarkup.tsx); or, the older way, a
 * preview over each question's label and keys. One 确定 sends every answer.
 */
function AskPlan({ callId, ask }: { callId: string; ask: Asked }) {
  const [picked, setPicked] = useState<Record<string, ReadonlySet<string>>>(
    () => Object.fromEntries(ask.questions.map(item => [item.id, new Set(item.defaults)])));
  const [note, setNote] = useState("");
  const multiple = (id: string) => ask.questions.find(item => item.id === id)?.multiple ?? false;
  const pick = (id: string, value: string) => setPicked(before => {
    const now = before[id] ?? new Set<string>();
    let next: Set<string>;
    if (multiple(id)) {
      next = new Set(now);
      if (next.has(value)) next.delete(value);
      else next.add(value);
    } else {
      next = now.has(value) ? new Set() : new Set([value]);
    }
    return { ...before, [id]: next };
  });
  const answered = ask.questions.every(item => (picked[item.id]?.size ?? 0) > 0);
  const submit = () => {
    const answers = Object.fromEntries(ask.questions.map(item => [item.id, [...(picked[item.id] ?? [])]]));
    sendAsk(callId, { answers, note: note.trim() || undefined });
    dismissTask(`ai-ask:${callId}`);
  };
  const pause = () => {
    sendAsk(callId, { answers: {}, cancelled: true });
    dismissTask(`ai-ask:${callId}`);
    void useAiStore.getState().abort();
  };
  return <form className="kd-ai-ask" data-plan="" onSubmit={event => { event.preventDefault(); submit(); }}>
    {ask.question && <p className="kd-ai-ask-title">{ask.question}</p>}
    {ask.body
      ? <PlanBody body={ask.body} media={ask.media} shots={ask.shots} picked={picked} onPick={pick} />
      : <>
          {ask.preview && <PlanText text={ask.preview} />}
          <div className="kd-ai-ask-questions">
            {ask.questions.map(item => <div key={item.id} className="kd-ai-ask-question" role="group" aria-label={item.question}>
              <span className="kd-ai-ask-label">{item.question}{item.multiple ? "（可多选）" : ""}</span>
              <div className="kd-ai-ask-row">
                {item.options.map(option => {
                  const on = picked[item.id]?.has(option) ?? false;
                  return <button key={option} type="button" className="kd-ai-choice" aria-pressed={on} onClick={() => pick(item.id, option)}>
                    {on && <Check size={12} aria-hidden="true" />}{option}
                  </button>;
                })}
              </div>
            </div>)}
          </div>
        </>}
    <NoteField note={note} onNote={setNote} canSend={answered || Boolean(note.trim())} onPause={pause} />
  </form>;
}

/** The question's body: songs to pick, text choices, and a line for the listener's own words. */
function AskPanel({ callId, ask }: { callId: string; ask: Asked }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(ask.defaults));
  const [note, setNote] = useState("");
  const choosing = ask.multiple || ask.songs.length > 0;
  const toggle = (value: string) => setPicked(before => {
    if (!ask.multiple) return before.has(value) ? new Set() : new Set([value]);
    const next = new Set(before);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });
  const submit = (choices: string[]) => {
    sendAsk(callId, { choices, note: note.trim() || undefined });
    dismissTask(`ai-ask:${callId}`);
  };
  const pause = () => {
    sendAsk(callId, { choices: [], cancelled: true });
    dismissTask(`ai-ask:${callId}`);
    void useAiStore.getState().abort();
  };
  return <div className="kd-ai-ask">
    {ask.preview && <PlanText text={ask.preview} />}
    {/* The whole question, not a line that scrolls. */}
    {ask.question && <PlanText text={ask.question} />}
    {ask.songs.length > 0 && <ul className="kd-ai-songs" role="group" aria-label={ask.multiple ? "可多选的歌曲" : "歌曲"}>
      {ask.songs.map(song => {
        const on = picked.has(song.ref);
        const platform = song.platform in PLATFORM_LABEL ? song.platform as Platform : null;
        return <li key={song.ref}>
          <button type="button" className="kd-ai-song" aria-pressed={on} onClick={() => toggle(song.ref)}>
            <SongCover song={song} />
            <span className="kd-ai-song-copy">
              <span className="kd-ai-song-title" title={song.title}>{song.title}</span>
              <span className="kd-ai-song-sub">
                {platform && <PlatformMark id={platform} size={11} branded />}
                {[platform ? PLATFORM_LABEL[platform] : "", song.artists.join(" / "), song.duration ? formatDuration(song.duration) : ""].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="kd-ai-song-mark" aria-hidden="true">{on && <Check size={14} />}</span>
          </button>
        </li>;
      })}
    </ul>}
    {ask.options.length > 0 && <div className="kd-ai-ask-row" role="group" aria-label="选项">
      {ask.options.map(option => <button key={option} type="button" className="kd-ai-choice" aria-pressed={choosing ? picked.has(option) : undefined}
        data-default={ask.defaults.includes(option) || undefined}
        onClick={() => { if (choosing) toggle(option); else submit([option]); }}>
        {choosing && picked.has(option) && <Check size={12} aria-hidden="true" />}{option}
      </button>)}
    </div>}
    <form onSubmit={event => { event.preventDefault(); submit([...picked]); }}>
      <NoteField note={note} onNote={setNote} canSend={picked.size > 0 || Boolean(note.trim())} onPause={pause} />
    </form>
  </div>;
}

function askBubble(callId: string, ask: Asked) {
  showTask({
    id: `ai-ask:${callId}`,
    kind: "ai",
    title: "需要你决定",
    icon: AI_MARK,
    stay: ask.timeout * 1000,
    resizable: true,
    controls: ask.questions.length > 0 ? <AskPlan callId={callId} ask={ask} /> : <AskPanel callId={callId} ask={ask} />,
    // Put away by hand: nothing chosen. Run out: pi takes the AI's default itself.
    onDismiss: reason => { if (reason === "user") sendAsk(callId, { choices: [], cancelled: true }); },
  });
}

// ---------------------------------------------------------------- other dialogs

/** The choices of another extension's dialog, as a row of keys. */
function DialogChoices({ id, method, options }: { id: string; method: string; options: string[] }) {
  const [value, setValue] = useState("");
  const choose = (body: { value?: string; confirmed?: boolean }) => {
    answer(id, body);
    dismissTask(`ai-dialog:${id}`);
  };
  if (method === "input" || method === "editor") {
    return <form className="kd-ai-ask-row" onSubmit={event => { event.preventDefault(); choose({ value }); }}>
      <input className="kd-ai-ask-input" value={value} onChange={event => setValue(event.target.value)} aria-label="回答" />
      <button type="submit" className="kd-ai-choice" data-default="true">确定</button>
    </form>;
  }
  return <div className="kd-ai-ask-row" role="group" aria-label="选项">
    {options.map(option => <button key={option} type="button" className="kd-ai-choice"
      onClick={() => choose(method === "confirm" ? { confirmed: option === options[0] } : { value: option })}>{option}</button>)}
  </div>;
}

function dialog(event: PiEvent) {
  const id = str(event.id);
  const method = str(event.method);
  const title = str(event.title);
  if (!id) return;
  // The dialog an ask_user call waits on: its bubble is drawn from the call's own update.
  if (method === "editor" && title.startsWith("kdj:ask:")) {
    const callId = title.slice("kdj:ask:".length);
    askDialogs.set(callId, id);
    const early = askEarly.get(callId);
    if (early !== undefined) {
      askEarly.delete(callId);
      answer(id, { value: early });
    }
    return;
  }
  if (method === "notify") {
    showTask({ id: `ai:notify:${id}`, kind: "ai", title: str(event.message), icon: AI_MARK,
      tone: event.notifyType === "error" ? "error" : "info", placement: "top", size: "small" });
    return;
  }
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
  const options = method === "select" ? strings(event.options) : method === "confirm" ? ["确定", "取消"] : [];
  showTask({
    id: `ai-dialog:${id}`,
    kind: "ai",
    title: title || "AI 需要你决定",
    detail: str(event.message) || undefined,
    icon: AI_MARK,
    stay: typeof event.timeout === "number" ? event.timeout : 0,
    controls: <DialogChoices id={id} method={method} options={options} />,
    onDismiss: reason => { if (reason === "user") answer(id, { cancelled: true }); },
  });
}

// ---------------------------------------------------------------- tell_user

function tell(callId: string, args: Fields) {
  const message = str(args.message).trim();
  if (!message) return;
  // A short line with no Markdown in it is the bubble's title; anything else is drawn as Markdown.
  const short = message.length <= SHORT_MESSAGE && !message.includes("\n") && !/[*`#|>\[~]/.test(message);
  const seconds = typeof args.seconds === "number" ? args.seconds : 0;
  showTask({
    id: `ai-tell:${callId}`,
    kind: "ai",
    title: short ? message : "AI",
    icon: AI_MARK,
    placement: "top",
    size: short ? "small" : "regular",
    stay: seconds * 1000,
    resizable: !short,
    controls: short ? undefined : <div className="kd-ai-message-md"><PlanText text={message} /></div>,
  });
}

// ---------------------------------------------------------------- the closing reply

/**
 * The task is done and the AI said what came of it: its words are a bubble that stays until put
 * away, and the steps' bubbles leave with the task (the drawer keeps them).
 */
function closingReply(text: string) {
  for (const id of stepBubbles) dismissTask(`ai:${id}`);
  stepBubbles.clear();
  const reply = text.trim();
  if (!reply) return;
  updateRun(run => ({ ...run, reply }));
  if (mainTask) return;
  const short = reply.length <= SHORT_MESSAGE && !reply.includes("\n") && !/[*`#|>\[~]/.test(reply);
  showTask({
    id: "ai-reply",
    kind: "ai",
    title: short ? reply : "AI",
    icon: AI_MARK,
    placement: "top",
    size: short ? "small" : "regular",
    stay: 0,
    resizable: !short,
    controls: short ? undefined : <div className="kd-ai-message-md"><PlanText text={reply} /></div>,
  });
}

// ---------------------------------------------------------------- the listener's tasks

/**
 * `text` is the listener's words as shown; `sent` is what pi got (the words and the dragged-in
 * cards, aiAttachments.ts), by which its echo is recognised; `attached` names the cards and `images`
 * are the pictures that went with it, sent again with it if it is sent again.
 */
interface UserLine { id: string; text: string; sent: string; attached: string[]; images: string[] }
interface UserTask extends UserLine { supplements: string[]; working: boolean }

/** The request under way, and the lines sent since that the AI has not taken in yet. */
let mainTask: UserTask | null = null;
let waiting: UserLine[] = [];
let taskSeq = 0;

function Attached({ titles }: { titles: string[] }) {
  return titles.length > 0 ? <p className="kd-ai-message kd-ai-task-more">附带：{titles.join("、")}</p> : null;
}

function TaskText({ task }: { task: UserTask }) {
  return <div className="kd-ai-task">
    <p className="kd-ai-message">{task.text}</p>
    <Attached titles={task.attached} />
    {task.supplements.map((line, index) => <p key={index} className="kd-ai-message kd-ai-task-more">补充：{line}</p>)}
  </div>;
}

function drawMain() {
  const task = mainTask;
  if (!task) return;
  showTask({
    id: `ai-task:${task.id}`,
    kind: "ai-task",
    title: task.working ? "正在做" : "等待开始",
    icon: task.working ? <LoaderCircle size={16} className="kd-spin" aria-hidden="true" /> : AI_MARK,
    stay: 0,
    controls: <TaskText task={task} />,
    body: <AiTaskTrace />,
    resizable: true,
    // The task stays in sight until it ends: it cannot be put away, only stopped with its key.
    held: true,
    actions: [{
      id: "stop",
      label: task.working ? "停止任务" : "撤销",
      icon: task.working ? <Square size={13} aria-hidden="true" /> : <Undo2 size={14} aria-hidden="true" />,
      onSelect: () => {
        if (task.working) void useAiStore.getState().abort();
        else {
          dismissTask(`ai-task:${task.id}`, "caller");
          stopTask();
        }
      },
    }],
  });
}

function drawWaiting(line: UserLine) {
  showTask({
    id: `ai-task:${line.id}`,
    kind: "ai-task",
    title: "补充 · 等待 AI 收到",
    icon: AI_MARK,
    stay: 0,
    controls: <div className="kd-ai-task"><p className="kd-ai-message">{line.text}</p><Attached titles={line.attached} /></div>,
    dismiss: { label: "撤销" },
    onDismiss: reason => { if (reason === "user") void takeBack(line.id); },
  });
}

/** The run the AI drawer's 任务 page shows (aiStore.run): a new request starts one. */
function updateRun(change: (run: AiRun) => AiRun) {
  const run = useAiStore.getState().run;
  if (run) useAiStore.setState({ run: change(run) });
}
function startRun(line: UserLine, supplements: string[] = [], resumed?: string) {
  useAiStore.setState({ run: { request: line.text, attached: line.attached, supplements, steps: [], trace: emptyTrace(), resumed } });
}

/** The listener sent a request: a task of its own, or a supplement to the one under way. */
export function userRequest(text: string, running: boolean, sent = text, attached: string[] = [], images: string[] = [], resumed?: string): string {
  taskSeq += 1;
  if (!mainTask) {
    mainTask = { id: `t${taskSeq}`, text, sent, attached, images, supplements: [], working: running };
    startRun(mainTask, [], resumed);
    drawMain();
    return mainTask.id;
  }
  const line = { id: `s${taskSeq}`, text, sent, attached, images };
  waiting.push(line);
  drawWaiting(line);
  return line.id;
}

/** The request never reached pi: its bubble goes. */
export function requestFailed(id: string) {
  if (mainTask?.id === id) {
    dismissTask(`ai-task:${id}`, "caller");
    mainTask = null;
  } else {
    waiting = waiting.filter(line => line.id !== id);
    dismissTask(`ai-task:${id}`, "caller");
  }
}

function stopTask() {
  mainTask = null;
  for (const line of waiting) dismissTask(`ai-task:${line.id}`, "caller");
  waiting = [];
  void useAiStore.getState().abort();
}

/** A supplement taken back before the AI took it in: pi's queue is emptied and the rest sent again. */
async function takeBack(id: string) {
  waiting = waiting.filter(line => line.id !== id);
  try {
    await aiApi.clearQueue();
    for (const line of waiting) await aiApi.prompt(line.sent, line.images, true);
  } catch (error) {
    aiProblem(error instanceof Error ? error.message : String(error));
  }
}

function userText(message: Fields): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(block => fields(block).type === "text" ? str(fields(block).text) : "").join("") : "";
}

function finishMain(title: string) {
  if (!mainTask) return;
  updateTask(`ai-task:${mainTask.id}`, {
    title, held: false, actions: [], icon: AI_MARK,
    body: <AiTaskTrace snapshot={useAiStore.getState().run?.trace ?? emptyTrace()} />,
  });
}

/** Everything the window does for one line of pi's stream. */
export function handlePiEvent(event: PiEvent) {
  updateRun(run => {
    const trace = reduceAiTrace(run.trace ?? emptyTrace(), event);
    return trace === run.trace ? run : { ...run, trace };
  });
  switch (event.type) {
    case "agent_start":
      if (!mainTask?.working) {
        // A new task: the last one's closing words go.
        lastReply = "";
        dismissTask("ai-reply");
      }
      aiTaskBegan();
      if (mainTask && !mainTask.working) {
        mainTask.working = true;
        drawMain();
      }
      return;
    case "message_start": {
      // A line the AI takes in: a supplement waiting for it joins the task.
      const message = fields(event.message);
      if (message.role !== "user") return;
      const text = userText(message).trim();
      const line = waiting.find(item => item.sent.trim() === text);
      if (!line || !mainTask) return;
      waiting = waiting.filter(item => item !== line);
      dismissTask(`ai-task:${line.id}`, "caller");
      mainTask.supplements.push(line.text);
      updateRun(run => ({ ...run, supplements: [...run.supplements, line.text] }));
      drawMain();
      return;
    }
    case "tool_execution_start": {
      const id = str(event.toolCallId), tool = str(event.toolName), args = fields(event.args);
      if (!id) return;
      calls.set(id, { tool, args });
      updateRun(run => ({ ...run, steps: [...run.steps, { id, tool, args, state: "running" }] }));
      if (tool === "kdj_search") gatherSearch(args);
      if (tool === "kdj_library_list") requestAiLibrary(args);
      if (tool === "kdj_play") {
        const trackId = Number(args.track_id);
        void import("../../lib/aiPlay").then(module => module.playLibraryTrack(trackId));
      }
      if (tool === "tell_user") tell(id, args);
      const notice = noticeOnStart(tool, args);
      if (notice) noticeBubble(id, notice, RUNNING_STAY_MS);
      return;
    }
    case "tool_execution_update": {
      const id = str(event.toolCallId);
      const call = calls.get(id);
      const details = fields(event.partialResult).details;
      if (call?.tool === "ask_user" || str(event.toolName) === "ask_user") {
        askBubble(id, asked(details));
        return;
      }
      // A render's percentage: on its bubble and on its step in the drawer.
      const step = call ? stepProgress(call.tool, details) : null;
      const notice = call && step ? noticeOnStart(call.tool, call.args) : null;
      if (!call || !step || !notice) return;
      noticeBubble(id, { ...notice, detail: step.line }, RUNNING_STAY_MS, step.progress);
      updateRun(run => ({ ...run, steps: run.steps.map(item => item.id === id ? { ...item, details } : item) }));
      return;
    }
    case "tool_execution_end": {
      const id = str(event.toolCallId);
      const call = calls.get(id) ?? { tool: str(event.toolName), args: {} };
      calls.delete(id);
      if (call.tool === "ask_user") {
        askDialogs.delete(id);
        askEarly.delete(id);
        dismissTask(`ai-ask:${id}`);
      }
      const result = fields(event.result);
      const failed = event.isError === true;
      updateRun(run => ({
        ...run,
        steps: run.steps.map(step => step.id === id
          ? { ...step, state: failed ? "failed" : "done", text: resultText(result), details: result.details }
          : step),
      }));
      const notice = noticeOnEnd(call.tool, call.args, result.details, event.isError === true, resultText(result));
      // A finished step stays the listener's usual length, a failed one twice that.
      if (notice) noticeBubble(id, notice, undefined);
      else dismissTask(`ai:${id}`);
      return;
    }
    case "extension_ui_request":
      dialog(event);
      return;
    case "message_end": {
      const message = fields(event.message);
      if (message.role === "assistant" && message.stopReason === "error") aiProblem(str(message.errorMessage) || "AI 出错了");
      // What the AI writes is its closing reply; a run stopped half-way has none.
      // Only the last message counts: words written between tool calls are not the outcome.
      if (message.role === "assistant") {
        lastReply = message.stopReason === "error" || message.stopReason === "aborted" ? "" : userText(message).trim();
      }
      return;
    }
    case "agent_settled":
      // A step that never ended (an aborted run) does not stay up.
      for (const [id, call] of calls) dismissTask(call.tool === "ask_user" ? `ai-ask:${id}` : `ai:${id}`);
      calls.clear();
      askDialogs.clear();
      askEarly.clear();
      closingReply(lastReply);
      finishMain(lastReply ? "已完成" : "已结束");
      lastReply = "";
      mainTask = null;
      if (waiting.length > 0) {
        const [first, ...rest] = waiting;
        for (const line of waiting) dismissTask(`ai-task:${line.id}`, "caller");
        waiting = [];
        mainTask = { ...first, supplements: rest.map(line => line.text), working: false };
        startRun(first, mainTask.supplements);
        drawMain();
      } else {
        // Nothing follows: the AI's closing words come up, and the window goes back to where the
        // listener was, if they left it be.
        aiTaskEnded();
      }
      return;
    case "kdj_exit":
    case "kdj_error":
      for (const [id, call] of calls) dismissTask(call.tool === "ask_user" ? `ai-ask:${id}` : `ai:${id}`);
      calls.clear();
      askDialogs.clear();
      askEarly.clear();
      finishMain("任务中断");
      for (const line of waiting) dismissTask(`ai-task:${line.id}`, "caller");
      mainTask = null;
      waiting = [];
      aiTaskEnded();
      aiProblem(str(event.message) || "pi 已退出");
      return;
  }
}
