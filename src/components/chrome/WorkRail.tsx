import {
  createElement,
  Fragment,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  adoptRail,
  clearRail,
  settleRail,
  startRail,
  turnRail,
  type RailTurn,
} from "./railTurn";

type RailZone = "glyph" | "text" | "tool";

interface RailItem {
  /** Unique on the strip: the zone and the key its owner gave it. */
  key: string;
  zone: RailZone;
  node: ReactNode;
  /** Running text gives way (an ellipsis) when the strip is short; everything else keeps its width. */
  yields: boolean;
}

function railItems(
  glyphs: ReactNode[],
  texts: ReactNode[],
  trailing: ReactNode,
  actions: ReactNode,
): { items: RailItem[]; elsewhere: ReactNode[] } {
  const items: RailItem[] = [];
  const elsewhere: ReactNode[] = [];
  const add = (zone: RailZone, node: ReactNode, fallback: string) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    const element = isValidElement<{ className?: unknown }>(node) ? node : null;
    // A portal draws its content somewhere else: it is not an item of this strip and does not turn.
    if (!element && typeof node === "object" && !(Symbol.iterator in node)) {
      elsewhere.push(node);
      return;
    }
    const className = typeof element?.props.className === "string" ? element.props.className : "";
    items.push({
      key: `${zone}/${element?.key ?? fallback}`,
      zone,
      node,
      yields: className.split(/\s+/).includes("kd-activity-text"),
    });
  };
  glyphs.forEach((node, index) => add("glyph", node, String(index)));
  texts.forEach((node, index) => add("text", node, String(index)));
  add("tool", trailing, "trailing");
  if (actions) add("tool", <div className="kd-activity-actions">{actions}</div>, "actions");
  return { items, elsewhere };
}

/**
 * Rails that take each other's place hand the strip over. A rail that stops being shown (its
 * pane is hidden, or it is unmounted) leaves what it showed behind for the length of that
 * commit; a rail that starts being shown in the same commit takes it, lets those items leave
 * as pictures and then lays out its own. React runs every layout cleanup of a commit before
 * any layout setup, so the order of the two rails in the tree does not matter.
 *
 * Only a rail that really stands where the other one stood takes it: the two share a pane, or
 * no other rail is on screen (one pane at a time). Two panes side by side keep their own.
 */
interface Handover {
  from: object;
  pane: Element | null;
  items: RailItem[];
}
const strip = { shown: new Set<object>(), left: null as Handover | null };

function leaveStrip(handover: Handover): void {
  strip.shown.delete(handover.from);
  strip.left = handover;
  queueMicrotask(() => {
    if (strip.left === handover) strip.left = null;
  });
}

function enterStrip(rail: object, pane: Element | null): RailItem[] | null {
  const left = strip.left;
  const taken =
    left && left.from !== rail && (strip.shown.size === 0 || (pane !== null && left.pane === pane))
      ? left.items
      : null;
  if (taken) strip.left = null;
  strip.shown.add(rail);
  return taken;
}

let pictureSerial = 0;

/** The turn's own animations on the marked items; none where nothing is animated (a hidden pane, a test). */
function turnAnimations(root: HTMLElement, selector: string): Animation[] {
  if (typeof root.getAnimations !== "function") return [];
  return [...root.querySelectorAll<HTMLElement>(selector)].flatMap((node) =>
    node.getAnimations().filter((animation) =>
      (animation as CSSAnimation).animationName?.startsWith("kd-motion-")),
  );
}

/**
 * 板块自有工作条：左侧小图标与说明，右侧可挂搜索/动作。
 * 空闲时也占位；忙时（多选 / 任务）只换内容，不跳布局。
 *
 * The strip stays and its content turns over (`railTurn.ts`): an item whose key goes is taken
 * away as an inert picture, the last one first; then the items whose keys are new are laid
 * out, the first one first; an item whose key is the same before and after is not touched and
 * only glides to its new place. `glyphs`, `texts`, `trailing` and `actions` are that order.
 * Give an item a new key when it is another thing (another folder's name), keep the key when
 * it is the same thing with other text (a progress count).
 */
export function WorkRail({
  idle = false,
  glyphs,
  texts,
  trailing,
  actions,
  label,
  shown = true,
}: {
  idle?: boolean;
  glyphs: ReactNode[];
  texts: ReactNode[];
  /** 贴右的附属控件（如曲库内搜），在全局入口左侧。 */
  trailing?: ReactNode;
  /** 本栏的全局入口，贴在右端，和搜索平台键上下对齐。 */
  actions?: ReactNode;
  label: string;
  /** False while the rail's pane is hidden: the rail that is shown instead takes the strip over. */
  shown?: boolean;
}) {
  const { items, elsewhere } = railItems(glyphs, texts, trailing, actions);
  const byKey = new Map(items.map((item) => [item.key, item]));
  const [stored, setTurn] = useState<RailTurn>(() => startRail(items.map((item) => item.key)));
  const turn = turnRail(stored, items.map((item) => item.key));
  if (turn !== stored) setTurn(turn);

  const root = useRef<HTMLDivElement>(null);
  /** What the last commit drew, and the pictures of what is leaving. */
  const memory = useRef({
    drawn: new Map<string, RailItem>(),
    showing: [] as RailItem[],
    pictures: new Map<number, RailItem>(),
    adopted: new Map<string, RailItem>(),
    /** Where the staying items stood before the pictures were taken out. */
    places: null as Map<string, number> | null,
  }).current;

  for (const slot of turn.slots) {
    if (slot.phase !== "out" || memory.pictures.has(slot.id) || memory.adopted.has(slot.key)) continue;
    const last = memory.drawn.get(slot.key);
    if (last) memory.pictures.set(slot.id, last);
  }

  useLayoutEffect(() => {
    memory.drawn = byKey;
    memory.showing = turn.slots.flatMap((slot) => (slot.phase === "out" ? [] : byKey.get(slot.key) ?? []));
    // Pictures are only on the strip while something leaves. Pictures taken over from another
    // rail are put down by the effect below before the turn that shows them is rendered, so
    // they are not judged by this render's slots.
    if (turn.stage !== "out") {
      memory.pictures.clear();
      memory.adopted.clear();
    }
  });

  const everShown = useRef(false);
  useLayoutEffect(() => {
    if (!shown) return;
    const pane = root.current?.closest(".kd-workspace-pane") ?? null;
    const taken = enterStrip(memory, pane);
    if (taken || everShown.current) {
      // Shown again without anyone to take over from: its own items are still laid out anew.
      const pictures = (taken ?? []).map((item) => ({ ...item, key: `picture:${(pictureSerial += 1)}` }));
      for (const picture of pictures) memory.adopted.set(picture.key, picture);
      const keys = pictures.map((picture) => picture.key);
      setTurn((current) => adoptRail(current, keys));
    }
    everShown.current = true;
    return () => leaveStrip({ from: memory, pane, items: memory.showing });
  }, [memory, shown]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const before = memory.places;
    memory.places = null;
    if (before) {
      // The pictures are out and the new items are in: what stayed closes up from where it stood.
      for (const node of element.querySelectorAll<HTMLElement>("[data-rail-slot]")) {
        const was = before.get(node.dataset.railSlot ?? "");
        const by = was === undefined ? 0 : was - node.offsetLeft;
        if (Math.abs(by) < 1) continue;
        node.style.setProperty("--kd-turn-shift", `${by}px`);
        node.setAttribute("data-kd-turn-shift", "");
        const arrived = () => {
          node.removeAttribute("data-kd-turn-shift");
          node.style.removeProperty("--kd-turn-shift");
        };
        const gliding = typeof node.getAnimations === "function" ? node.getAnimations() : [];
        if (gliding.length === 0) arrived();
        else void Promise.allSettled(gliding.map((animation) => animation.finished)).then(arrived);
      }
    }
    if (turn.stage === "rest") return;
    const { beat, stage } = turn;
    let live = true;
    const advance = () => {
      if (!live) return;
      if (stage === "out") {
        memory.places = new Map(
          [...element.querySelectorAll<HTMLElement>("[data-rail-slot]:not([data-kd-turn]):not([hidden])")]
            .map((node) => [node.dataset.railSlot ?? "", node.offsetLeft]),
        );
      }
      setTurn((current) =>
        current.beat !== beat ? current : stage === "out" ? clearRail(current) : settleRail(current));
    };
    const moving = turnAnimations(element, `[data-kd-turn="${stage}"]`);
    // Nothing moves (nothing to take away, a hidden pane, no animation engine): the stage is over.
    if (moving.length === 0) advance();
    else void Promise.allSettled(moving.map((animation) => animation.finished)).then(advance);
    return () => {
      live = false;
    };
    // One wait per stage begun; `turn` of that render is the stage it waits for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn.beat]);

  const zone = (name: RailZone) =>
    turn.slots.flatMap((slot) => {
      const leaving = slot.phase === "out";
      const item = leaving
        ? memory.adopted.get(slot.key) ?? memory.pictures.get(slot.id)
        : byKey.get(slot.key);
      if (!item || item.zone !== name) return [];
      return (
        <span
          key={slot.id}
          className="kd-rail-item"
          data-rail-slot={slot.id}
          data-yields={item.yields ? "true" : undefined}
          data-kd-turn={slot.phase === "in" || leaving ? slot.phase : undefined}
          style={slot.phase === "in" || leaving ? ({ "--kd-turn-step": slot.step } as CSSProperties) : undefined}
          // Held back while another rail's pictures leave: mounted, so a field keeps its state.
          hidden={slot.phase === "wait" || undefined}
          // A leaving item is a picture: it takes no click and no focus and is not announced.
          aria-hidden={leaving || undefined}
          inert={leaving || undefined}
        >
          {item.node}
        </span>
      );
    });
  const glyphSlots = zone("glyph");

  return (
    <div
      ref={root}
      className="kd-activity"
      data-idle={idle ? "true" : undefined}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {glyphSlots.length > 0 ? <div className="kd-activity-glyphs">{glyphSlots}</div> : null}
      <div className="kd-activity-texts">{zone("text")}</div>
      {zone("tool")}
      {createElement(Fragment, null, ...elsewhere)}
    </div>
  );
}

export function WorkRailSelection({
  count,
  onSelectAll,
  onClear,
  onDone,
  actions,
}: {
  count: number;
  onSelectAll(): void;
  onClear(): void;
  onDone(): void;
  actions?: ReactNode;
}) {
  return (
    <span className="kd-activity-selection">
      <strong>已选 {count}</strong>
      <button type="button" onClick={onSelectAll}>
        全选
      </button>
      <button type="button" disabled={count === 0} onClick={onClear}>
        清除
      </button>
      {actions}
      <button type="button" onClick={onDone}>
        完成
      </button>
    </span>
  );
}
