import { Children, isValidElement, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { clearTextSelection } from "../../lib/textSelection";

export interface PanelStackProps {
  /** localStorage 的键。不同的面板栈各存各的顺序。 */
  storageKey: string;
  /**
   * 每个直接子元素必须带 `key`——它就是这个面板的 id。
   * 用 key 而不是另开一个 `panelId` prop 的理由：这些子元素本来就要有 key，
   * 再要求写一遍同样的字符串，早晚会有一处对不上，而对不上是静默的。
   */
  children: ReactNode;
}

function load(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 一叠可以拖着换顺序的面板。顺序长期保存，换一首歌还是这个顺序。
 *
 * 为什么把顺序做成用户可调：右侧这几块（元数据 / 分析 / 接下一首 /
 * 评分 / 调号轮）谁在上面，完全取决于当下在干什么——整理曲库时看元数据，
 * 排 set 时看接下一首。与其替用户选一个，不如让他自己拖一次、然后永远不用再想。
 *
 * 存的是 id 列表而不是完整顺序快照：以后加/删面板时，没记录过的新面板
 * 自动排在末尾（见下面的 `rank`），旧的存档不会因此失效。
 */
export function PanelStack({ storageKey, children }: PanelStackProps) {
  const [order, setOrder] = useState(() => load(storageKey));
  /** 正在拖的那块的 id。 */
  const [dragging, setDragging] = useState<string | null>(null);
  /** 悬停到哪块上了——用来画插入位置的横线。 */
  const [over, setOver] = useState<string | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      pointerDragCleanupRef.current?.();
    },
    [],
  );

  const items = Children.toArray(children).filter(isValidElement);
  // React 给 Children.toArray 的 key 加了 ".$" 前缀，剥掉才是我们写的那个
  const idOf = (child: { key: string | null }) => String(child.key ?? "").replace(/^\.\$/, "");

  // 没记录过的排末尾：新增面板不需要动存档，老用户下次打开就看到它在最下面
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const sorted = [...items].sort((a, b) => rank(idOf(a)) - rank(idOf(b)));

  const commit = (from: string, to: string) => {
    if (from === to) return;
    // 以**当前看到的顺序**为基准重排，而不是以存档为基准：存档里可能缺
    // 新面板的 id，拿它当基准会让新面板在第一次拖动时凭空跳位
    const ids = sorted.map(idOf);
    const next = ids.filter((id) => id !== from);
    // 目标在移除源面板后可能向前挪一格，必须按 next 找位置；否则从上往下拖
    // 会落到目标的下面，看起来就像排序失效。
    next.splice(next.indexOf(to), 0, from);
    localStorage.setItem(storageKey, JSON.stringify(next));
    setOrder(next);
  };

  /**
   * WKWebView 的原生 draggable 会偶发只触发 dragstart、却不触发 drop，
   * 所以面板排序直接跟踪指针；松开时按坐标找目标面板。这也让触摸屏可用。
   */
  const beginPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, from: string) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();

    pointerDragCleanupRef.current?.();
    setDragging(null);
    setOver(null);

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;

    const slotAt = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      const slot = hit?.closest<HTMLElement>(".kd-panel-slot[data-panel-stack]");
      return slot?.dataset.panelStack === storageKey ? slot : null;
    };
    const stopTracking = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      pointerDragCleanupRef.current = null;
    };
    const finish = () => {
      stopTracking();
      setDragging(null);
      setOver(null);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const distance = Math.hypot(move.clientX - startX, move.clientY - startY);
      if (!active && distance < 4) return;
      move.preventDefault();
      if (!active) {
        active = true;
        clearTextSelection();
        setDragging(from);
      }
      const target = slotAt(move.clientX, move.clientY)?.dataset.panelId ?? null;
      setOver((current) => (current === target ? current : target));
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const target = slotAt(up.clientX, up.clientY)?.dataset.panelId ?? null;
      const shouldCommit = active && target !== null;
      finish();
      if (shouldCommit) commit(from, target);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) finish();
    };

    pointerDragCleanupRef.current = stopTracking;
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  };

  return (
    <>
      {sorted.map((child) => {
        const id = idOf(child);
        return (
          <div
            key={id}
            className="kd-panel-slot"
            data-panel-stack={storageKey}
            data-panel-id={id}
            data-dragging={dragging === id ? "true" : undefined}
            data-over={over === id && dragging !== id ? "true" : undefined}
          >
            {/* 只有这个把手可拖：整块可拖的话，面板里那些按钮、输入框、
                波形上的点击拖动全都会先被拖拽劫走 */}
            <button
              type="button"
              className="kd-panel-grip"
              aria-label="拖动调整面板顺序"
              title="拖动调整顺序"
              onPointerDown={(event) => beginPointerDrag(event, id)}
            >
              <GripVertical size={12} />
            </button>
            {child}
          </div>
        );
      })}
    </>
  );
}
