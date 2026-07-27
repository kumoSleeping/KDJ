import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  BarChart3,
  ClipboardPaste,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Library,
  ListMusic,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useQueueStore } from "../../stores/queueStore";
import type { FolderNode } from "../../types";
import { InlineNotice } from "../common";

/** 拖曲目到文件夹用的 MIME。自定义类型才能在 dragover 阶段就认出是不是自家的拖拽。 */
export const TRACK_DND_TYPE = "application/x-kdj-tracks";
/** 拖文件夹换顺序用的 MIME，和上面分开，dragover 时才好区别对待。 */
const FOLDER_DND_TYPE = "application/x-kdj-folder";

/** 所有“添加音乐”入口共用同一个动作：选目录后登记、扫描并自动分析。 */
export async function pickAndScanFolders(): Promise<void> {
  const paths = await window.kdj?.pickFolders();
  if (!paths?.length) return;
  await useLibraryStore.getState().startScan(paths, true);
}

function flattenFolders(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolders(node.children)]);
}

/**
 * 窄屏常驻文件夹栏。收起时也能直接切换添加/临时列表/全库/任意文件夹；
 * 展开时是占据布局宽度的真正侧栏，不覆盖列表，也不再退化成抽屉。
 */
export function NarrowFolderRail({ expanded, onToggle }: { expanded: boolean; onToggle(): void }) {
  const folders = useLibraryStore((state) => state.folders);
  const filter = useLibraryStore((state) => state.filter);
  const queueView = useLibraryStore((state) => state.queueView);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const setQueueView = useLibraryStore((state) => state.setQueueView);
  const setListMode = useAppStore((state) => state.setListMode);
  const [error, setError] = useState("");

  if (expanded) {
    return (
      <aside className="kd-narrow-folder-panel" aria-label="文件夹侧栏">
        <button className="kd-narrow-rail-toggle" type="button" onClick={onToggle} title="收起文件夹栏">
          <PanelLeftClose size={15} />
          <span>文件夹</span>
        </button>
        <FolderTree />
      </aside>
    );
  }

  const choose = (folder: string) => {
    setQueueView(false);
    setFilter({ folder, folderDeep: false });
    setListMode("library");
  };
  return (
    <aside className="kd-narrow-folder-rail kd-scroll" aria-label="快捷文件夹栏">
      <button type="button" onClick={onToggle} title="展开文件夹栏" aria-label="展开文件夹栏">
        <PanelLeftOpen size={15} />
      </button>
      <button
        type="button"
        title={error || "添加音乐文件夹"}
        aria-label="添加音乐文件夹"
        onClick={() => {
          setError("");
          void pickAndScanFolders().catch((reason: unknown) => setError((reason as Error).message));
        }}
      >
        <FolderPlus size={15} /><small>添加</small>
      </button>
      <button
        type="button"
        data-active={queueView || undefined}
        title="临时列表"
        onClick={() => { setQueueView(true); setListMode("library"); }}
      >
        <ListMusic size={15} /><small>临时</small>
      </button>
      <button
        type="button"
        data-active={!queueView && !filter.folder || undefined}
        title="全部曲目"
        onClick={() => choose("")}
      >
        <Library size={15} /><small>全部</small>
      </button>
      <span className="kd-narrow-rail-sep" />
      {flattenFolders(folders?.roots ?? []).map((node) => (
        <button
          key={node.path}
          type="button"
          data-active={!queueView && filter.folder === node.path || undefined}
          title={node.path}
          onClick={() => choose(node.path)}
        >
          {node.is_root ? <HardDrive size={14} /> : <Folder size={14} />}
          <small>{node.name.slice(0, 2)}</small>
        </button>
      ))}
    </aside>
  );
}

interface MenuState {
  node: FolderNode;
  x: number;
  y: number;
}

/** 拖文件夹排序时的落点：插到某个兄弟的前面还是后面。 */
interface DragInfo {
  parent: string;
  name: string;
}

/** 这棵树里 path 对应的节点是否还有没入库的文件。 */
function hasPending(node: FolderNode, path: string): boolean {
  if (node.path === path) return node.pending_count > 0;
  return node.children.some((child) => hasPending(child, path));
}

function reorder(names: string[], from: string, to: string, after: boolean): string[] {
  const rest = names.filter((name) => name !== from);
  const index = rest.indexOf(to);
  if (index < 0) return names;
  rest.splice(after ? index + 1 : index, 0, from);
  return rest;
}

/** 展开状态存在组件里：刷新树（新建/改名/移动之后）不该把用户展开的分支收回去。 */
function useExpanded(roots: FolderNode[]) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    // 根目录默认展开一层，否则第一眼是一排收起来的目录，等于什么都没有。
    // 必须在"确实有新东西要加"时才换 Set：否则每次渲染都产生新状态，
    // 而 roots 每次渲染又是新数组，两下一凑就是死循环。
    setExpanded((prev) => {
      const missing = roots.filter((root) => !prev.has(root.path));
      if (missing.length === 0) return prev;
      const next = new Set(prev);
      missing.forEach((root) => next.add(root.path));
      return next;
    });
  }, [roots]);
  return [expanded, setExpanded] as const;
}

export function FolderTree() {
  const folders = useLibraryStore((state) => state.folders);
  const filter = useLibraryStore((state) => state.filter);
  const clipboard = useLibraryStore((state) => state.clipboard);
  const queueView = useLibraryStore((state) => state.queueView);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const setQueueView = useLibraryStore((state) => state.setQueueView);
  const refreshFolders = useLibraryStore((state) => state.refreshFolders);
  const applyFolderOp = useLibraryStore((state) => state.applyFolderOp);
  const paste = useLibraryStore((state) => state.paste);
  const startScan = useLibraryStore((state) => state.startScan);
  const startAnalyze = useLibraryStore((state) => state.startAnalyze);
  // 动了文件夹或曲库搜索 = 现在关心的是本地，把中间那对切回曲库。
  // 搜索结果不丢，列表面板顶边的标签随时能切回去。
  const setListMode = useAppStore((state) => state.setListMode);
  const queueCount = useQueueStore((state) => state.ids.length);

  const roots = folders?.roots ?? [];
  const [expanded, setExpanded] = useExpanded(roots);
  const [importing, setImporting] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [dropEdge, setDropEdge] = useState<"" | "before" | "after">("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  /**
   * 文件夹操作失败就地贴在这一栏底下。原来走的是全局弹窗，
   * 但拖拽/改名这类操作的"哪里出错了"必须和被操作的那棵树待在一起，
   * 弹窗飘走之后用户只剩一个没变化的界面。
   */
  const [notice, setNotice] = useState("");

  /**
   * 「添加文件夹」是一个动作，不是一次作业：选完目录之后登记曲库根、扫描、
   * 把新曲目排进分析队列这三件事全在后台自动做完，用户不需要再点第二下。
   * 所以 `startScan` 的 analyze 恒为 true——它是这个动作语义的一部分，不是可选项。
   *
   * 失败原因分两处：这里 catch 得到的是"任务都没起来"（比如挑的路径没权限），
   * 真正扫描过程中的失败随 `scan.progress` 的终局事件走，显示在曲目表上方
   * 那条工具条里（LibraryToolbar 的 importError）——两处都不能省。
   */
  const scan = useLibraryStore((state) => state.scan);
  const scanning = scan !== null && scan.phase !== "done";
  const addFolders = async () => {
    setNotice("");
    try {
      await pickAndScanFolders();
    } catch (error) {
      setNotice(`添加文件夹失败：${(error as Error).message}`);
    }
  };
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (useLibraryStore.getState().folders === null) void refreshFolders();
  }, [refreshFolders]);

  // 扫描结束（scan.progress 到 done → refreshFolders）后清掉"导入中"标记
  useEffect(() => {
    setImporting((current) => {
      if (!current) return current;
      const stale = folders?.roots.some((root) => hasPending(root, current)) ?? false;
      return stale ? current : "";
    });
  }, [folders]);

  // 点别处 / 按 Esc 关掉右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /**
   * 点开一个还没入库的目录 = 顺手把它导进来。用户不该为了看见歌先去点一次「添加文件夹」。
   * 和「添加文件夹」一样，导入完自动排进分析队列——分析是后台该自己做完的事。
   * 进行中的反馈就是那颗计数徽标变成「…」，不再弹窗。
   */
  const importPending = (node: FolderNode) => {
    if (node.pending_count <= 0 || importing) return;
    setImporting(node.path);
    setNotice("");
    void startScan([node.path], true).catch((error: unknown) => {
      setImporting("");
      setNotice(`导入「${node.name}」失败：${(error as Error).message}`);
    });
  };

  const runOp = (ids: number[], dest: string, alt: boolean) => {
    if (ids.length === 0) return;
    const op = alt ? "link" : "move";
    setNotice("");
    void applyFolderOp(ids, dest, op)
      .then((result) => {
        // 全成功不报喜：曲目已经出现在目标文件夹里了，那就是最好的回执。
        // 只有部分失败才要说话，否则用户会以为整批都搬过去了。
        const failed = Object.keys(result.errors).length;
        if (failed === 0) return;
        const detail = Object.entries(result.methods)
          .map(([method, count]) => `${METHOD_LABEL[method] ?? method} ${count}`)
          .join(" · ");
        setNotice(
          `${op === "link" ? "链接" : "移动"} ${result.track_ids.length} 首${detail ? `（${detail}）` : ""}，${failed} 首失败`,
        );
      })
      .catch((error: unknown) => setNotice(`操作失败：${(error as Error).message}`));
  };

  const prompt = (title: string, initial = "") => {
    const value = window.prompt(title, initial);
    return value === null ? null : value.trim();
  };

  const siblingsOf = (parentPath: string, node: FolderNode): string[] => {
    if (node.path === parentPath) return node.children.map((child) => child.name);
    for (const child of node.children) {
      const found = siblingsOf(parentPath, child);
      if (found.length > 0) return found;
    }
    return [];
  };

  const applyReorder = (parentPath: string, from: string, to: string, after: boolean) => {
    const names = roots.map((root) => siblingsOf(parentPath, root)).find((list) => list.length > 0);
    if (!names) return;
    void api
      .orderFolder(parentPath, reorder(names, from, to, after))
      .then(() => refreshFolders())
      .catch((error: unknown) => setNotice(`排序保存失败：${(error as Error).message}`));
  };

  const render = (node: FolderNode, depth: number) => {
    const open = expanded.has(node.path);
    // 临时列表视图开着时没有任何文件夹算"当前"——中列显示的不是文件夹内容
    const active = filter.folder === node.path && !queueView;
    return (
      <div key={node.path}>
        <div
          className="kd-folder"
          data-active={active}
          data-drop={dropTarget === node.path && dropEdge === ""}
          data-edge={dropTarget === node.path ? dropEdge || undefined : undefined}
          style={{ paddingLeft: `${0.35 + depth * 0.85}rem` }}
          title={node.path}
          // 根目录不参与排序：它的顺序在设置里的曲库目录列表决定，
          // 而且它没有"父目录的清单"可写。
          draggable={!node.is_root}
          onClick={() => {
            setListMode("library");
            // 进文件夹默认按手排顺序看（set 是按演出顺序排的）；
            // 回到全库时手排没有意义，还原成默认的按入库时间。
            setFilter(
              active
                ? { folder: "", sort: "added_at", order: "desc" }
                : { folder: node.path, sort: "custom" },
            );
            if (!active) importPending(node);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ node, x: event.clientX, y: event.clientY });
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.setData(
              FOLDER_DND_TYPE,
              JSON.stringify({ parent: node.parent, name: node.name } satisfies DragInfo),
            );
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            const types = event.dataTransfer.types;
            if (types.includes(FOLDER_DND_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              // 落在行中间的 40% = 放进这个文件夹（整块反白）；
              // 上下两边 = 插到它前面/后面（画一条插入线）。和访达一个手感。
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientY - rect.top) / rect.height;
              setDropTarget(node.path);
              setDropEdge(ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "");
              return;
            }
            if (!types.includes(TRACK_DND_TYPE)) return;
            event.preventDefault();
            // Option/Alt = 链接，其余 = 移动。光标形状先把这个意图说清楚。
            event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
            setDropTarget(node.path);
            setDropEdge("");
          }}
          onDragLeave={() =>
            setDropTarget((prev) => {
              if (prev !== node.path) return prev;
              setDropEdge("");
              return "";
            })
          }
          onDrop={(event) => {
            event.preventDefault();
            const edge = dropEdge;
            setDropTarget("");
            setDropEdge("");
            const folderRaw = event.dataTransfer.getData(FOLDER_DND_TYPE);
            if (folderRaw) {
              try {
                const info = JSON.parse(folderRaw) as DragInfo;
                const from = `${info.parent}/${info.name}`;
                if (from === node.path) return; // 拖到自己身上，什么都不做
                if (edge === "") {
                  // 落在行中间 = 放进这个文件夹里（真实的目录移动）
                  void api
                    .moveFolder(from, node.path)
                    .then(() => {
                      // 树上文件夹换了位置就是回执本身，不再弹窗
                      // 当前筛选指向的旧路径没了，跟着走到新位置
                      if (filter.folder === from) setFilter({ folder: `${node.path}/${info.name}` });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => setNotice((error as Error).message));
                } else if (info.parent === node.parent) {
                  // 同一层的上下边缘 = 换顺序
                  applyReorder(node.parent, info.name, node.name, edge === "after");
                } else {
                  // 跨层拖到边缘：先搬到同一层，落在末尾。再想精确插位，
                  // 在同层里拖一次就行——不为一个少见操作把接口做复杂。
                  void api
                    .moveFolder(from, node.parent)
                    .then(() => {
                      if (filter.folder === from) setFilter({ folder: `${node.parent}/${info.name}` });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => setNotice((error as Error).message));
                }
              } catch {
                setNotice("拖拽数据读不出来");
              }
              return;
            }
            const raw = event.dataTransfer.getData(TRACK_DND_TYPE);
            if (!raw) return;
            try {
              runOp(JSON.parse(raw) as number[], node.path, event.altKey);
            } catch {
              setNotice("拖拽数据读不出来");
            }
          }}
        >
          <button
            type="button"
            className="kd-folder-caret"
            aria-label={open ? "收起" : "展开"}
            disabled={node.children.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              toggle(node.path);
            }}
          >
            {node.children.length > 0 ? (
              open ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )
            ) : null}
          </button>
          {node.is_root ? (
            <HardDrive size={13} />
          ) : open && node.children.length > 0 ? (
            <FolderOpen size={13} />
          ) : (
            <Folder size={13} />
          )}
          <span className="kd-truncate">{node.name}</span>
          {/* 未入库的用不同的样子标出来，点一下就导入——空文件夹和"没扫过"是两回事 */}
          {node.pending_count > 0 ? (
            <span
              className="kd-folder-count"
              data-pending="true"
              title={`${node.pending_count} 个文件还没进曲库，点一下这个文件夹就导入`}
            >
              {importing === node.path ? "…" : `+${node.pending_count}`}
            </span>
          ) : (
            node.total_count > 0 && <span className="kd-folder-count">{node.total_count}</span>
          )}
          <button
            type="button"
            className="kd-folder-more"
            aria-label="文件夹操作"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ node, x: rect.left, y: rect.bottom + 2 });
            }}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
        {open && node.children.map((child) => render(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="kd-folder-pane">
      {/* 曲库的小搜索放这里：它筛的是"我已经有的歌"，和顶上那条
          "去网上搜歌来下"完全是两件事，分开放才不会点错。 */}
      <div className="kd-folder-search">
        <Search size={12} className="kd-faint" />
        <input
          value={filter.q}
          placeholder="在曲库里找"
          aria-label="搜索曲库"
          onChange={(event) => {
            setListMode("library");
            setFilter({ q: event.target.value });
          }}
        />
        {filter.q && (
          <button type="button" aria-label="清空" onClick={() => setFilter({ q: "" })}>
            <X size={11} />
          </button>
        )}
      </div>

      {/* 原来这里有一行「文件夹」标题 + 「初始化顺序」图标 + 「含子级」勾选。
          全删了：
          · 标题——左栏里除了文件夹没有别的东西，不用再说一遍；
          · 初始化顺序——一个不说自己是干嘛的图标按钮，点了也看不出发生了什么。
            真要拖动排序时，`applyFolderOp` 会自己按需写清单，不必先手动点一下；
          · 含子级——选中一个歌单文件夹时，想看的本来就是它整棵子树里的曲目，
            默认就该是"含"。做成开关只是把一个没人会关的选项摆在最显眼的位置。
      `folderDeep` 字段保留在 store 里（后端 API 仍然收它），默认恒为 true。 */}
      <div className="kd-scroll kd-folder-list">
        {/* 添加是曲库入口，不是底部工具：和「临时列表」「全部曲目」并列放在
            列表最上面，点它直接选择磁盘目录并开始后台扫描。 */}
        <button
          type="button"
          className="kd-folder kd-folder-action"
          disabled={scanning}
          title="选磁盘上的文件夹加进曲库，导入和分析都在后台自动做完"
          onClick={() => void addFolders()}
        >
          <span className="kd-folder-caret" />
          <FolderInput size={13} />
          <span className="kd-truncate">添加</span>
        </button>
        <div
          className="kd-folder"
          data-active={queueView}
          style={{ paddingLeft: "0.35rem" }}
          onClick={() => {
            setListMode("library");
            setQueueView(true);
          }}
        >
          <span className="kd-folder-caret" />
          <ListMusic size={13} />
          <span className="kd-truncate">
            临时列表 <span className="kd-folder-count">({queueCount})</span>
          </span>
        </div>
        <div
          className="kd-folder"
          data-active={filter.folder === "" && !queueView}
          style={{ paddingLeft: "0.35rem" }}
          onClick={() => {
            setListMode("library");
            setFilter({ folder: "", sort: "added_at", order: "desc" });
          }}
        >
          <span className="kd-folder-caret" />
          <Library size={13} />
          <span className="kd-truncate">全部曲目</span>
        </div>
        {roots.map((root) => render(root, 0))}
        {roots.length === 0 && (
          <p className="kd-faint" style={{ padding: "0.6rem 0.5rem", lineHeight: 1.5 }}>
            还没有文件夹。点上方的「添加」选一个本地目录，剩下的交给后台。
          </p>
        )}
        {folders && folders.outside > 0 && (
          <p className="kd-faint" style={{ padding: "0.5rem", lineHeight: 1.5 }}>
            另有 {folders.outside} 首在曲库目录之外，只能在「全部曲目」里看到。
          </p>
        )}
      </div>

      {/* 文件夹操作出错时，消息必须留在被操作的树旁边。 */}
      <InlineNotice
        className="kd-folder-notice"
        block
        text={notice}
        onDismiss={() => setNotice("")}
      />

      {menu && (
        <div
          ref={menuRef}
          className="kd-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              const name = prompt("新文件夹名称");
              if (!name) return;
              void api
                .createFolder(menu.node.path, name)
                .then(() => refreshFolders())
                .catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <FolderPlus size={12} />
            新建子文件夹
          </button>
          <button
            type="button"
            disabled={menu.node.is_root}
            title={menu.node.is_root ? "曲库根目录去设置里改" : undefined}
            onClick={() => {
              setMenu(null);
              const name = prompt("重命名文件夹", menu.node.name);
              if (!name || name === menu.node.name) return;
              void api
                .renameFolder(menu.node.path, name)
                .then(() => {
                  // 改名后当前筛选指向的旧路径已经不存在了，跟着切到新路径
                  if (filter.folder === menu.node.path) {
                    const parent = menu.node.path.slice(0, menu.node.path.lastIndexOf("/"));
                    setFilter({ folder: `${parent}/${name}` });
                  }
                  return refreshFolders();
                })
                .catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <PencilLine size={12} />
            重命名
          </button>
          <button type="button" onClick={() => {
            const folder = menu.node.path;
            setMenu(null);
            void (async () => {
              // 后端单页最多 1000 首，文件夹可能远大于这个数；完整翻页后
              // 一次性交给分析队列，避免右键看似成功却只分析前 1000 首。
              const ids: number[] = [];
              let offset = 0;
              while (true) {
                const page = await api.tracks({ folder, folder_deep: 1, limit: 1000, offset });
                ids.push(...page.items.map((track) => track.id));
                offset += page.items.length;
                if (page.items.length === 0 || offset >= page.total) break;
              }
              await startAnalyze(ids, false);
            })().catch((error: unknown) => setNotice((error as Error).message));
          }}>
            <BarChart3 size={12} />
            分析此文件夹
          </button>
          {/* 粘贴：底栏那颗按钮删掉之后，这里是它唯一的界面入口。
              键盘走 Cmd/Ctrl+V（见 useLibraryClipboard）。 */}
          <button
            type="button"
            disabled={!clipboard}
            title={
              clipboard
                ? `把剪贴板里的 ${clipboard.ids.length} 首${clipboard.op === "move" ? "移动" : "链接"}到这里`
                : "先在曲目表里按 Cmd/Ctrl+C 或 Cmd/Ctrl+X"
            }
            onClick={() => {
              const dest = menu.node.path;
              setMenu(null);
              setNotice("");
              void paste(dest).catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <ClipboardPaste size={12} />
            粘贴{clipboard ? ` ${clipboard.ids.length} 首` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              void window.kdj?.openPath(menu.node.path);
            }}
          >
            <FolderOpen size={12} />
            在访达中打开
          </button>
          <button
            type="button"
            data-danger="true"
            disabled={menu.node.is_root || menu.node.total_count > 0}
            title={
              menu.node.is_root
                ? "曲库根目录去设置里移除"
                : menu.node.total_count > 0
                  ? "里面还有曲目，先移走再删"
                  : undefined
            }
            onClick={() => {
              setMenu(null);
              void api
                .deleteFolder(menu.node.path)
                .then(() => {
                  if (filter.folder === menu.node.path) setFilter({ folder: "" });
                  return refreshFolders();
                })
                .catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <Trash2 size={12} />
            删除空文件夹
          </button>
        </div>
      )}
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = {
  move: "移动",
  hardlink: "硬链接",
  symlink: "符号链接",
  copy: "复制",
};
