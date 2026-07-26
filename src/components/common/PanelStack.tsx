import { Children, isValidElement, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";

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
 * 为什么把顺序做成用户可调：右侧这几块（元数据 / 分析 / 接下一首 / 文件 /
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
    next.splice(ids.indexOf(to), 0, from);
    localStorage.setItem(storageKey, JSON.stringify(next));
    setOrder(next);
  };

  return (
    <>
      {sorted.map((child) => {
        const id = idOf(child);
        return (
          <div
            key={id}
            className="kd-panel-slot"
            data-dragging={dragging === id ? "true" : undefined}
            data-over={over === id && dragging !== id ? "true" : undefined}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              setOver(id);
            }}
            onDragLeave={() => setOver((current) => (current === id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging) commit(dragging, id);
              setDragging(null);
              setOver(null);
            }}
          >
            {/* 只有这个把手可拖：整块可拖的话，面板里那些按钮、输入框、
                波形上的点击拖动全都会先被拖拽劫走 */}
            <button
              type="button"
              className="kd-panel-grip"
              aria-label="拖动调整面板顺序"
              title="拖动调整顺序"
              draggable
              onDragStart={(event) => {
                setDragging(id);
                event.dataTransfer.effectAllowed = "move";
                // Firefox 不设 data 就不触发 drag 事件
                event.dataTransfer.setData("text/plain", id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
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
