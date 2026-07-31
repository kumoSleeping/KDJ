import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  BarChart3,
  Clapperboard,
  ClipboardPaste,
  Link2,
  Folder,
  FolderDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Files,
  HardDrive,
  Library,
  ListMusic,
  ListX,
  MoreHorizontal,
  Music2,
  PencilLine,
  Trash2,
} from "lucide-react";
import { api } from "../../lib/api";
import {
  FOLDER_DROP_PATH_ATTR,
  SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR,
  SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
} from "../../lib/folderDrop";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder, OUTSIDE_FOLDER } from "../../lib/outsideFolder";
import {
  enqueueSearchDrop,
  isSearchDownloadDrag,
} from "../../lib/searchDrag";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import {
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_DND_TYPE,
} from "../../lib/trackDrag";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useQueueStore } from "../../stores/queueStore";
import { useVjExportStore } from "../../stores/vjExportStore";
import type { FolderNode } from "../../types";
import { ContextMenu, InlineNotice } from "../common";

/** @deprecated 请从 `lib/trackDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { TRACK_DND_TYPE };
/** 拖文件夹换顺序用的 MIME，和上面分开，dragover 时才好区别对待。 */
const FOLDER_DND_TYPE = "application/x-kdj-folder";
const QUEUE_DROP_TARGET = "__kd_queue__";
const ALL_TRACKS_DROP_TARGET = "__kd_all_tracks__";

function trackIdsFromDrop(event: React.DragEvent): number[] {
  const ids = readTrackDragIds(event.dataTransfer);
  finishTrackDrop();
  return ids;
}

async function enqueueTrackIds(ids: number[]): Promise<{ added: number; failed: number }> {
  const unique = [...new Set(ids)];
  const loaded = await Promise.allSettled(unique.map((id) => api.track(id)));
  const tracks = loaded.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (tracks.length > 0) useQueueStore.getState().add(tracks);
  return { added: tracks.length, failed: unique.length - tracks.length };
}

const cleanPath = (path: string | undefined) => (path ?? "").replace(/\/+$/, "");

function folderPurpose(path: string, audioDir?: string, videoDir?: string) {
  const normalized = cleanPath(path);
  const audio = normalized !== "" && normalized === cleanPath(audioDir);
  const video = normalized !== "" && normalized === cleanPath(videoDir?.trim() ? videoDir : audioDir);
  if (!audio && !video) return null;
  return {
    audio,
    video,
    label: audio && video ? "默认音乐和视频下载目录" : audio ? "默认音乐下载目录" : "默认视频下载目录",
  };
}

/**
 * 文件夹类型与“默认下载落点”只占一个图标位。
 * 旧版在 Folder 后面再排 Music/Clapperboard，看起来像两个独立操作；
 * 默认目录现在直接用 FolderDown，具体是音乐、视频还是两者仍由 title 说明。
 */
function FolderGlyph({
  path,
  audioDir,
  videoDir,
  root,
  open,
  size,
}: {
  path: string;
  audioDir?: string;
  videoDir?: string;
  root: boolean;
  open: boolean;
  size: number;
}) {
  const purpose = folderPurpose(path, audioDir, videoDir);
  if (purpose) {
    return (
      <span className="kd-folder-purpose" title={purpose.label} aria-label={purpose.label}>
        <FolderDown size={size} />
      </span>
    );
  }
  return (
    root ? <HardDrive size={size} /> : open ? <FolderOpen size={size} /> : <Folder size={size} />
  );
}

/** 所有“添加音乐”入口共用同一个动作：选目录后登记、扫描；是否自动分析由全局开关决定。 */
export async function pickAndScanFolders(): Promise<void> {
  const paths = await window.kdj?.pickFolders();
  if (!paths?.length) return;
  const autoAnalyze = useAppStore.getState().settings?.auto_analyze ?? true;
  await useLibraryStore.getState().startScan(paths, autoAnalyze);
}

function flattenFolders(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolders(node.children)]);
}

/**
 * 窄屏常驻文件夹栏。收起时也能直接切换添加/临时列表/全库/任意文件夹；
 * 展开时是占据布局宽度的真正侧栏，不覆盖列表，也不再退化成抽屉。
 */
export function NarrowFolderRail({
  expanded,
  onNavigate,
}: {
  expanded: boolean;
  /** 点选文件夹 / 临时列表 / 全部曲目等导航项后回调（竖屏收起弹出面板用）。 */
  onNavigate?: () => void;
}) {
  const folders = useLibraryStore((state) => state.folders);
  const filter = useLibraryStore((state) => state.filter);
  const queueView = useLibraryStore((state) => state.queueView);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const setQueueView = useLibraryStore((state) => state.setQueueView);
  const settings = useAppStore((state) => state.settings);
  const applyFolderOp = useLibraryStore((state) => state.applyFolderOp);
  const [error, setError] = useState("");
  const [narrowDrop, setNarrowDrop] = useState("");

  useEffect(() => {
    const clearDrop = () => setNarrowDrop("");
    window.addEventListener("dragend", clearDrop, true);
    return () => window.removeEventListener("dragend", clearDrop, true);
  }, []);

  if (expanded) {
    return (
      <aside className="kd-narrow-folder-panel" aria-label="文件夹侧栏">
        <FolderTree onNavigate={onNavigate} />
      </aside>
    );
  }

  const choose = (folder: string) => {
    setQueueView(false);
    setFilter({ folder, folderDeep: false });
    onNavigate?.();
  };
  return (
    <aside className="kd-narrow-folder-rail kd-scroll" aria-label="快捷文件夹栏">
      <button
        type="button"
        title={error || "添加音乐文件夹"}
        aria-label="添加音乐文件夹"
        onClick={() => {
          setError("");
          void pickAndScanFolders().catch((reason: unknown) => setError((reason as Error).message));
        }}
      >
        <FolderPlus size={15} /><small>添加音乐</small>
      </button>
      <button
        type="button"
        data-active={queueView || undefined}
        data-drop={narrowDrop === QUEUE_DROP_TARGET ? "true" : undefined}
        title="临时列表"
        onClick={() => {
          setQueueView(true);
          onNavigate?.();
        }}
        onDragOverCapture={(event) => {
          if (!isTrackDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setNarrowDrop(QUEUE_DROP_TARGET);
        }}
        onDragLeave={() => setNarrowDrop("")}
        onDropCapture={(event) => {
          event.preventDefault();
          const ids = trackIdsFromDrop(event);
          setNarrowDrop("");
          void enqueueTrackIds(ids).then(({ failed }) => {
            if (failed > 0) setError(`${failed} 首未能加入临时列表`);
          });
        }}
      >
        <ListMusic size={15} /><small>临时列表</small>
      </button>
      <button
        type="button"
        {...{ [SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR]: "" }}
        data-active={!queueView && filter.folder === "" || undefined}
        data-drop={narrowDrop === ALL_TRACKS_DROP_TARGET ? "true" : undefined}
        title="全部曲目（拖入下载会落到默认下载文件夹）"
        onClick={() => choose("")}
        onDragOverCapture={(event) => {
          if (!isSearchDownloadDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setNarrowDrop(ALL_TRACKS_DROP_TARGET);
        }}
        onDragLeave={() =>
          setNarrowDrop((current) => (current === ALL_TRACKS_DROP_TARGET ? "" : current))
        }
        onDropCapture={(event) => {
          event.preventDefault();
          setNarrowDrop("");
          if (!isSearchDownloadDrag(event)) return;
          void enqueueSearchDrop(event, SEARCH_DEFAULT_DOWNLOAD_SENTINEL).catch(
            (reason: unknown) => setError((reason as Error).message),
          );
        }}
      >
        <Library size={15} /><small>全部曲目</small>
      </button>
      <span className="kd-narrow-rail-sep" />
      {flattenFolders(folders?.roots ?? []).map((node) => (
        <button
          key={node.path}
          type="button"
          {...{ [FOLDER_DROP_PATH_ATTR]: node.path }}
          data-active={!queueView && filter.folder === node.path || undefined}
          data-drop={narrowDrop === node.path ? "true" : undefined}
          title={node.path}
          onClick={() => choose(node.path)}
          onDragOverCapture={(event) => {
            if (isSearchDownloadDrag(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setNarrowDrop(node.path);
              return;
            }
            if (!isTrackDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = event.altKey ? "move" : "copy";
            setNarrowDrop(node.path);
          }}
          onDragLeave={() => setNarrowDrop((current) => (current === node.path ? "" : current))}
          onDropCapture={(event) => {
            event.preventDefault();
            setNarrowDrop("");
            if (isSearchDownloadDrag(event)) {
              void enqueueSearchDrop(event, node.path).catch((reason: unknown) =>
                setError((reason as Error).message),
              );
              return;
            }
            const ids = trackIdsFromDrop(event);
            if (ids.length === 0) return;
            const op = resolveLibraryPasteOp({
              settings: useAppStore.getState().settings,
              forceMove: event.altKey,
            });
            void applyFolderOp(ids, node.path, op).catch((reason: unknown) =>
              setError((reason as Error).message),
            );
          }}
        >
          <span className="kd-narrow-folder-icons">
            <FolderGlyph
              path={node.path}
              audioDir={settings?.download_dir}
              videoDir={settings?.download_dir}
              root={node.is_root}
              open={false}
              size={14}
            />
          </span>
          <small>{node.name}</small>
        </button>
      ))}
      {(folders?.outside ?? 0) > 0 && (
        <button
          type="button"
          data-active={!queueView && isOutsideFolder(filter.folder) || undefined}
          title="不在曲库目录里的曲目"
          onClick={() => choose(OUTSIDE_FOLDER)}
        >
          <Files size={15} /><small>其他</small>
        </button>
      )}
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

export function FolderTree({
  onNavigate,
}: {
  /** 点选文件夹 / 临时列表 / 全部曲目等导航项后回调（竖屏收起弹出面板用）。 */
  onNavigate?: () => void;
} = {}) {
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
  const forgetFolder = useLibraryStore((state) => state.forgetFolder);
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const queueCount = useQueueStore((state) => state.ids.length);
  const statsTotal = useLibraryStore((state) => state.stats?.total);
  /** 移出曲库的二次确认：第一次上膛，第二次才执行（和曲目表删文件同套路）。 */
  const [forgetArmed, setForgetArmed] = useState("");

  const roots = folders?.roots ?? [];
  const allTrackCount =
    statsTotal ??
    roots.reduce((sum, root) => sum + root.total_count, 0) + (folders?.outside ?? 0);
  const [expanded, setExpanded] = useExpanded(roots);
  const [importing, setImporting] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [dropEdge, setDropEdge] = useState<"" | "before" | "after">("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newFolder, setNewFolder] = useState<{ parent: string; name: string; saving: boolean } | null>(null);
  /**
   * 文件夹操作失败就地贴在这一栏底下。原来走的是全局弹窗，
   * 但拖拽/改名这类操作的"哪里出错了"必须和被操作的那棵树待在一起，
   * 弹窗飘走之后用户只剩一个没变化的界面。
   */
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const clearDrop = () => {
      setDropTarget("");
      setDropEdge("");
    };
    window.addEventListener("dragend", clearDrop, true);
    return () => window.removeEventListener("dragend", clearDrop, true);
  }, []);

  /**
   * 「添加文件夹」是一个动作：选完目录之后登记曲库根并扫描；自动分析开着时，
   * 新曲目会继续在后台分析，关掉时只入库，用户可稍后从右键菜单手动分析。
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

  // 换节点时清掉「移出」上膛态（关闭由 ContextMenu 自己处理）
  useEffect(() => {
    setForgetArmed("");
  }, [menu?.node.path]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /**
   * 点开一个还没入库的目录 = 顺手把它导进来。用户不该为了看见歌先去点一次「添加文件夹」。
   * 自动分析开着时导入完继续排队；暂停时只导入。
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
    const op = resolveLibraryPasteOp({
      settings: useAppStore.getState().settings,
      forceMove: alt,
    });
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
        const verb = op === "move" ? "移动" : op === "copy" ? "复制" : "链接";
        setNotice(
          `${verb} ${result.track_ids.length} 首${detail ? `（${detail}）` : ""}，${failed} 首失败`,
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

  const commitNewFolder = () => {
    if (!newFolder || newFolder.saving) return;
    const name = newFolder.name.trim();
    if (!name) {
      setNewFolder(null);
      return;
    }
    setNewFolder({ ...newFolder, saving: true });
    setNotice("");
    void api
      .createFolder(newFolder.parent, name)
      .then(() => refreshFolders())
      .then(() => setNewFolder(null))
      .catch((error: unknown) => {
        setNewFolder((current) => current ? { ...current, saving: false } : current);
        setNotice(`新建文件夹失败：${(error as Error).message}`);
      });
  };

  const render = (node: FolderNode, depth: number) => {
    const open = expanded.has(node.path);
    // 临时列表视图开着时没有任何文件夹算"当前"——中列显示的不是文件夹内容
    const active = filter.folder === node.path && !queueView;
    return (
      <div key={node.path}>
        <div
          className="kd-folder"
          {...{ [FOLDER_DROP_PATH_ATTR]: node.path }}
          data-active={active}
          data-drop={dropTarget === node.path && dropEdge === ""}
          data-edge={dropTarget === node.path ? dropEdge || undefined : undefined}
          style={{ paddingLeft: `${0.35 + depth * 0.85}rem` }}
          title={node.path}
          // 根目录不参与排序：它的顺序在设置里的曲库目录列表决定，
          // 而且它没有"父目录的清单"可写。
          onClick={(event) => {
            if (hasTextSelectionWithin(event.currentTarget)) return;
            // 进文件夹默认按手排顺序看（set 是按演出顺序排的）；
            // 回到全库时手排没有意义，还原成默认的按入库时间。
            setFilter(
              active
                ? { folder: "", sort: "added_at", order: "desc" }
                : { folder: node.path, sort: "custom" },
            );
            if (!active) importPending(node);
            onNavigate?.();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ node, x: event.clientX, y: event.clientY });
          }}
          onDragOverCapture={(event) => {
            const types = Array.from(event.dataTransfer.types);
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
            if (isSearchDownloadDrag(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropTarget(node.path);
              setDropEdge("");
              return;
            }
            if (!isTrackDrag(event)) return;
            event.preventDefault();
            // 默认创建硬链接；按住 Option/Alt 才移动原文件。光标先把意图说清楚。
            event.dataTransfer.dropEffect = event.altKey ? "move" : "copy";
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
          onDropCapture={(event) => {
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
            if (isSearchDownloadDrag(event)) {
              // 搜到的歌/视频拖进文件夹 = 入队并落进这里；左表立刻出现待下载行。
              void enqueueSearchDrop(event, node.path).catch((error: unknown) =>
                setNotice((error as Error).message),
              );
              return;
            }
            const ids = trackIdsFromDrop(event);
            if (ids.length === 0) return;
            runOp(ids, node.path, event.altKey);
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
          <span
            className="kd-folder-drag"
            draggable={!node.is_root}
            title={node.is_root ? undefined : "拖动文件夹图标移动或排序"}
            onDragStart={(event) => {
              if (node.is_root) return;
              event.stopPropagation();
              clearTextSelection();
              event.dataTransfer.setData(
                FOLDER_DND_TYPE,
                JSON.stringify({ parent: node.parent, name: node.name } satisfies DragInfo),
              );
              event.dataTransfer.effectAllowed = "move";
            }}
          >
            <FolderGlyph
              path={node.path}
              audioDir={settings?.download_dir}
              videoDir={settings?.download_dir}
              root={node.is_root}
              open={open && node.children.length > 0}
              size={13}
            />
          </span>
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
        {newFolder?.parent === node.path && (
          <div
            className="kd-folder kd-folder-new"
            style={{ paddingLeft: `${0.35 + (depth + 1) * 0.85}rem` }}
          >
            <span className="kd-folder-caret" />
            <Folder size={13} />
            <input
              autoFocus
              aria-label="新文件夹名称"
              value={newFolder.name}
              disabled={newFolder.saving}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setNewFolder({ ...newFolder, name: event.target.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commitNewFolder();
                if (event.key === "Escape") setNewFolder(null);
              }}
            />
          </div>
        )}
        {open && node.children.map((child) => render(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="kd-folder-pane">
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
          data-drop={dropTarget === QUEUE_DROP_TARGET}
          style={{ paddingLeft: "0.35rem" }}
          onClick={() => {
            setQueueView(true);
            onNavigate?.();
          }}
          onDragOverCapture={(event) => {
            if (!isTrackDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropTarget(QUEUE_DROP_TARGET);
            setDropEdge("");
          }}
          onDragLeave={() =>
            setDropTarget((current) => (current === QUEUE_DROP_TARGET ? "" : current))
          }
          onDropCapture={(event) => {
            event.preventDefault();
            const ids = trackIdsFromDrop(event);
            setDropTarget("");
            void enqueueTrackIds(ids).then(({ added, failed }) => {
              if (failed > 0) setNotice(`已加入 ${added} 首，${failed} 首读取失败`);
            });
          }}
        >
          <span className="kd-folder-caret" />
          <ListMusic size={13} />
          <span className="kd-truncate">临时列表</span>
          <span className="kd-folder-count">{queueCount}</span>
        </div>
        <div
          className="kd-folder"
          {...{ [SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR]: "" }}
          data-active={filter.folder === "" && !queueView}
          data-drop={dropTarget === ALL_TRACKS_DROP_TARGET ? "true" : undefined}
          style={{ paddingLeft: "0.35rem" }}
          title="拖入下载会落到默认下载文件夹"
          onClick={() => {
            setFilter({ folder: "", sort: "added_at", order: "desc" });
            onNavigate?.();
          }}
          onDragOverCapture={(event) => {
            if (!isSearchDownloadDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropTarget(ALL_TRACKS_DROP_TARGET);
            setDropEdge("");
          }}
          onDragLeave={() =>
            setDropTarget((current) => {
              if (current !== ALL_TRACKS_DROP_TARGET) return current;
              setDropEdge("");
              return "";
            })
          }
          onDropCapture={(event) => {
            event.preventDefault();
            setDropTarget("");
            setDropEdge("");
            if (!isSearchDownloadDrag(event)) return;
            void enqueueSearchDrop(event, SEARCH_DEFAULT_DOWNLOAD_SENTINEL).catch(
              (error: unknown) => setNotice((error as Error).message),
            );
          }}
        >
          <span className="kd-folder-caret" />
          <Library size={13} />
          <span className="kd-truncate">全部曲目</span>
          <span className="kd-folder-count">{allTrackCount}</span>
        </div>
        {roots.map((root) => render(root, 0))}
        {roots.length === 0 && (
          <p className="kd-faint" style={{ padding: "0.6rem 0.5rem", lineHeight: 1.5 }}>
            还没有文件夹。点上方的「添加」选一个本地目录，剩下的交给后台。
          </p>
        )}
        {(folders?.outside ?? 0) > 0 && (
          <div
            className="kd-folder"
            data-active={isOutsideFolder(filter.folder) && !queueView}
            style={{ paddingLeft: "0.35rem" }}
            title="不在曲库目录里的曲目"
            onClick={() => {
              setFilter({ folder: OUTSIDE_FOLDER, sort: "added_at", order: "desc" });
              onNavigate?.();
            }}
          >
            <span className="kd-folder-caret" />
            <Files size={13} />
            <span className="kd-truncate">其他</span>
            <span className="kd-folder-count">{folders!.outside}</span>
          </div>
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
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            onClick={() => {
              const parent = menu.node.path;
              setMenu(null);
              setExpanded((current) => new Set(current).add(parent));
              setNewFolder({ parent, name: "新建文件夹", saving: false });
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
          <button
            type="button"
            onClick={() => {
              const folder = menu.node.path;
              setMenu(null);
              useAppStore.getState().openVjExportPanel();
              void useVjExportStore.getState().open(folder);
            }}
          >
            <Clapperboard size={12} />
            按顺序导出 VJ
          </button>
          {(() => {
            const path = menu.node.path;
            const downloadPath = cleanPath(settings?.download_dir);
            const isDownload = cleanPath(path) === downloadPath;
            return (
              <button
                type="button"
                disabled={isDownload}
                title={isDownload ? "已经是当前下载文件夹" : "下载的音频和视频都会进这里"}
                onClick={() => {
                  setMenu(null);
                  void saveSettings({ download_dir: path, video_download_dir: path }).catch(
                    (error: unknown) => setNotice((error as Error).message),
                  );
                }}
              >
                <Music2 size={12} />
                设为下载文件夹{isDownload ? " · 当前" : ""}
              </button>
            );
          })()}
          {/* 链接 = 硬链接；粘贴 = 移动。键盘 Cmd/Ctrl+V 走设置，Option+V 移动。 */}
          <button
            type="button"
            disabled={!clipboard}
            title={
              clipboard
                ? `把剪贴板里的 ${clipboard.ids.length} 首链接到这里`
                : "先在曲目表里按 Cmd/Ctrl+C 或 Cmd/Ctrl+X"
            }
            onClick={() => {
              const dest = menu.node.path;
              setMenu(null);
              setNotice("");
              void paste(dest, "link").catch((error: unknown) =>
                setNotice((error as Error).message),
              );
            }}
          >
            <Link2 size={12} />
            链接{clipboard ? ` ${clipboard.ids.length} 首` : ""}
          </button>
          <button
            type="button"
            disabled={!clipboard}
            title={
              clipboard
                ? `把剪贴板里的 ${clipboard.ids.length} 首移动到这里`
                : "先在曲目表里按 Cmd/Ctrl+C 或 Cmd/Ctrl+X"
            }
            onClick={() => {
              const dest = menu.node.path;
              setMenu(null);
              setNotice("");
              void paste(dest, "move").catch((error: unknown) =>
                setNotice((error as Error).message),
              );
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
            title={
              menu.node.is_root
                ? "注销这个曲库根，并把下面的歌从软件里摘掉；磁盘文件不动"
                : "把这个文件夹里的歌从软件里摘掉；磁盘文件不动"
            }
            onClick={() => {
              const path = menu.node.path;
              const count = menu.node.total_count;
              const isRoot = menu.node.is_root;
              // 有曲目时上膛一次，避免右键误触把整库摘空
              if (count > 0 && forgetArmed !== path) {
                setForgetArmed(path);
                return;
              }
              setMenu(null);
              setForgetArmed("");
              void forgetFolder(path)
                .then(async (removed) => {
                  try {
                    const next = await api.getSettings();
                    useAppStore.setState({ settings: next });
                  } catch {
                    /* 设置晚一拍不挡主流程 */
                  }
                  setNotice(
                    removed > 0
                      ? `已移出曲库 ${removed} 首（文件仍在磁盘）`
                      : isRoot
                        ? "已移出曲库根目录（文件仍在磁盘）"
                        : "这个文件夹里本来就没有入库曲目",
                  );
                })
                .catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <ListX size={12} />
            {forgetArmed === menu.node.path && menu.node.total_count > 0
              ? `确认移出 ${menu.node.total_count} 首？文件保留`
              : menu.node.is_root
                ? `移出曲库根${menu.node.total_count > 0 ? `（${menu.node.total_count} 首）` : ""}`
                : `移出曲库${menu.node.total_count > 0 ? `（${menu.node.total_count} 首）` : ""}`}
          </button>
          <button
            type="button"
            data-danger="true"
            disabled={menu.node.is_root || menu.node.total_count > 0}
            title={
              menu.node.is_root
                ? "曲库根请用上面的「移出曲库根」；这里只删磁盘上空文件夹"
                : menu.node.total_count > 0
                  ? "里面还有曲目，先移出曲库或移走再删"
                  : "从磁盘删除这个空文件夹"
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
        </ContextMenu>
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
