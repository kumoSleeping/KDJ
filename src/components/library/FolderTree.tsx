import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  ListOrdered,
  Library,
  MoreHorizontal,
  PencilLine,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { FolderNode } from "../../types";

/** 拖曲目到文件夹用的 MIME。自定义类型才能在 dragover 阶段就认出是不是自家的拖拽。 */
export const TRACK_DND_TYPE = "application/x-kumodeck-tracks";
/** 拖文件夹换顺序用的 MIME，和上面分开，dragover 时才好区别对待。 */
const FOLDER_DND_TYPE = "application/x-kumodeck-folder";

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
  const setFilter = useLibraryStore((state) => state.setFilter);
  const refreshFolders = useLibraryStore((state) => state.refreshFolders);
  const applyFolderOp = useLibraryStore((state) => state.applyFolderOp);
  const paste = useLibraryStore((state) => state.paste);
  const startScan = useLibraryStore((state) => state.startScan);
  const pushToast = useAppStore((state) => state.pushToast);
  const autoAnalyze = useAppStore((state) => state.settings?.auto_analyze ?? true);
  // 动了文件夹或曲库搜索 = 现在关心的是本地，把中间那对切回曲库。
  // 搜索结果不丢，列表面板顶边的标签随时能切回去。
  const setListMode = useAppStore((state) => state.setListMode);

  const roots = folders?.roots ?? [];
  // 有任何一个根还没写清单，就把「初始化」亮出来
  const needsInit = roots.some((root) => !root.managed);
  const [expanded, setExpanded] = useExpanded(roots);
  const [importing, setImporting] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [dropEdge, setDropEdge] = useState<"" | "before" | "after">("");
  const [menu, setMenu] = useState<MenuState | null>(null);
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

  /** 点开一个还没入库的目录 = 顺手把它扫进来。用户不该为了看见歌先去点「扫描目录」。 */
  const importPending = (node: FolderNode) => {
    if (node.pending_count <= 0 || importing) return;
    setImporting(node.path);
    void startScan([node.path], autoAnalyze)
      .then(() => pushToast("info", `正在导入「${node.name}」的 ${node.pending_count} 个文件`))
      .catch((error: unknown) => {
        setImporting("");
        pushToast("error", `导入失败：${(error as Error).message}`);
      });
  };

  const runOp = (ids: number[], dest: string, alt: boolean) => {
    if (ids.length === 0) return;
    const op = alt ? "link" : "move";
    void applyFolderOp(ids, dest, op)
      .then((result) => {
        const failed = Object.keys(result.errors).length;
        const detail = Object.entries(result.methods)
          .map(([method, count]) => `${METHOD_LABEL[method] ?? method} ${count}`)
          .join(" · ");
        pushToast(
          failed > 0 ? "warn" : "info",
          `${op === "link" ? "链接" : "移动"} ${result.track_ids.length} 首${detail ? `（${detail}）` : ""}` +
            (failed > 0 ? `，${failed} 首失败` : ""),
        );
      })
      .catch((error: unknown) => pushToast("error", `操作失败：${(error as Error).message}`));
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
      .catch((error: unknown) => pushToast("error", `排序保存失败：${(error as Error).message}`));
  };

  const render = (node: FolderNode, depth: number) => {
    const open = expanded.has(node.path);
    const active = filter.folder === node.path;
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
                      pushToast("info", `已把「${info.name}」移到「${node.name}」里`);
                      // 当前筛选指向的旧路径没了，跟着走到新位置
                      if (filter.folder === from) setFilter({ folder: `${node.path}/${info.name}` });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => pushToast("error", (error as Error).message));
                } else if (info.parent === node.parent) {
                  // 同一层的上下边缘 = 换顺序
                  applyReorder(node.parent, info.name, node.name, edge === "after");
                } else {
                  // 跨层拖到边缘：先搬到同一层，落在末尾。再想精确插位，
                  // 在同层里拖一次就行——不为一个少见操作把接口做复杂。
                  void api
                    .moveFolder(from, node.parent)
                    .then(() => {
                      pushToast("info", `已把「${info.name}」移到「${node.name}」同级`);
                      if (filter.folder === from) setFilter({ folder: `${node.parent}/${info.name}` });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => pushToast("error", (error as Error).message));
                }
              } catch {
                pushToast("error", "拖拽数据读不出来");
              }
              return;
            }
            const raw = event.dataTransfer.getData(TRACK_DND_TYPE);
            if (!raw) return;
            try {
              runOp(JSON.parse(raw) as number[], node.path, event.altKey);
            } catch {
              pushToast("error", "拖拽数据读不出来");
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

      <div className="kd-folder-head">
        <span className="kd-folder-title">文件夹</span>
        <button
          type="button"
          className="kd-folder-more"
          style={{ display: "inline-flex", marginLeft: "auto" }}
          aria-label="初始化顺序"
          title={
            needsInit
              ? "在每层目录里写一份 .kumodeck.json，之后可以拖动调整顺序（配置跟着文件夹走）"
              : "顺序已受管，可以直接拖动文件夹调整"
          }
          disabled={!needsInit}
          onClick={() => {
            void api
              .initFolders()
              .then(() => {
                pushToast("info", "已在每层目录写入 .kumodeck.json，现在可以拖动排序了");
                return refreshFolders();
              })
              .catch((error: unknown) => pushToast("error", (error as Error).message));
          }}
        >
          <ListOrdered size={12} />
        </button>
        <label className="kd-folder-deep" title="连子文件夹里的曲目一起列出来">
          <input
            type="checkbox"
            checked={filter.folderDeep}
            onChange={(event) => setFilter({ folderDeep: event.target.checked })}
          />
          含子级
        </label>
      </div>

      <div className="kd-scroll kd-folder-list">
        <div
          className="kd-folder"
          data-active={filter.folder === ""}
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
            还没有曲库目录。去「设置 → 曲库目录」加一个，或者点上方的「扫描目录」。
          </p>
        )}
        {folders && folders.outside > 0 && (
          <p className="kd-faint" style={{ padding: "0.5rem", lineHeight: 1.5 }}>
            另有 {folders.outside} 首在曲库目录之外，只能在「全部曲目」里看到。
          </p>
        )}
      </div>

      <div className="kd-folder-foot">
        <button
          type="button"
          className="kd-btn"
          data-size="sm"
          data-variant="ghost"
          disabled={!filter.folder}
          title={filter.folder ? "在选中的文件夹里新建子文件夹" : "先选一个文件夹"}
          onClick={() => {
            const name = prompt("新文件夹名称");
            if (!name) return;
            void api
              .createFolder(filter.folder, name)
              .then(() => refreshFolders())
              .catch((error: unknown) => pushToast("error", (error as Error).message));
          }}
        >
          <FolderPlus size={12} />
          新建
        </button>
        <button
          type="button"
          className="kd-btn"
          data-size="sm"
          data-variant="ghost"
          disabled={!clipboard || !filter.folder}
          title={
            clipboard
              ? `粘贴 ${clipboard.ids.length} 首（${clipboard.op === "move" ? "移动" : "链接"}）`
              : "先在曲目表里 Cmd+C / Cmd+X"
          }
          onClick={() => {
            void paste(filter.folder)
              .then((result) => {
                if (result) pushToast("info", `粘贴 ${result.track_ids.length} 首`);
              })
              .catch((error: unknown) => pushToast("error", (error as Error).message));
          }}
        >
          <ClipboardPaste size={12} />
          粘贴{clipboard ? ` ${clipboard.ids.length}` : ""}
        </button>
      </div>

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
                .catch((error: unknown) => pushToast("error", (error as Error).message));
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
                .catch((error: unknown) => pushToast("error", (error as Error).message));
            }}
          >
            <PencilLine size={12} />
            重命名
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              void window.kumodeck?.openPath(menu.node.path);
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
                .catch((error: unknown) => pushToast("error", (error as Error).message));
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
