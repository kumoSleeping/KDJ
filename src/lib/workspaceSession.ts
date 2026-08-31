import type { StreamPlaylist } from "../types";
import { writeLocalStorageNow, writeLocalStorageSoon } from "./storageWrite";

const STORAGE_KEY = "kd-workspace-session-v1";
const MAX_TEXT = 4_096;
const MAX_SCROLL = 1_000_000_000;
const DEFAULT_LOCAL_SORT = "file_created_at";

export type RestorableWorkspaceSource = "local" | "stream";

export interface LocalWorkspaceSession {
  folder: string;
  folderDeep: boolean;
  sort: string;
  order: "asc" | "desc";
  sort2: string | null;
  order2: "asc" | "desc";
  selectedId: number | null;
  scrollTop: number;
}

export interface StreamWorkspaceSession {
  playlist: StreamPlaylist | null;
  /** 打开页面时的平台账号身份；换号后不得把上一账号的私人歌单误恢复到当前账号。 */
  accountKey: string | null;
  inspectedGroup: string | null;
  scrollTop: number;
}

export interface WorkspaceSession {
  version: 1;
  source: RestorableWorkspaceSource;
  local: LocalWorkspaceSession;
  stream: StreamWorkspaceSession;
}

export const DEFAULT_WORKSPACE_SESSION: WorkspaceSession = {
  version: 1,
  source: "local",
  local: {
    folder: "",
    folderDeep: true,
    sort: DEFAULT_LOCAL_SORT,
    order: "desc",
    sort2: null,
    order2: "asc",
    selectedId: null,
    scrollTop: 0,
  },
  stream: {
    playlist: null,
    accountKey: null,
    inspectedGroup: null,
    scrollTop: 0,
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : fallback;
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function scroll(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_SCROLL, Math.max(0, value))
    : 0;
}

function playlist(value: unknown): StreamPlaylist | null {
  const item = record(value);
  if (
    !item ||
    !["wyy", "qqm", "soundcloud", "ytm", "youtube", "bilibili"].includes(
      String(item.platform),
    )
  ) return null;
  const key = text(item.key);
  const title = text(item.title);
  const cover = text(item.cover);
  if (!key || !title) return null;
  return {
    platform: item.platform as StreamPlaylist["platform"],
    key,
    title,
    cover,
    count:
      typeof item.count === "number" && Number.isFinite(item.count)
        ? Math.max(0, Math.trunc(item.count))
        : 0,
    is_favorite: item.is_favorite === true,
    origin: text(item.origin),
  };
}

export function normalizeWorkspaceSession(value: unknown): WorkspaceSession {
  const root = record(value);
  const local = record(root?.local);
  const streamState = record(root?.stream);
  const source = root?.source === "stream"
    ? root.source
    : "local";
  const storedSort = text(local?.sort, DEFAULT_LOCAL_SORT);
  return {
    version: 1,
    source,
    local: {
      folder: text(local?.folder),
      folderDeep: local?.folderDeep !== false,
      // added_at 是旧版不可见的默认键，不是用户从列头选择的偏好。恢复旧会话时
      // 一并迁移，否则升级后仍会继续把重新入库的老文件排到最前。
      sort: storedSort === "added_at" ? DEFAULT_LOCAL_SORT : storedSort,
      order: local?.order === "asc" ? "asc" : "desc",
      sort2: typeof local?.sort2 === "string" ? text(local.sort2) || null : null,
      order2: local?.order2 === "desc" ? "desc" : "asc",
      selectedId: positiveId(local?.selectedId),
      scrollTop: scroll(local?.scrollTop),
    },
    stream: {
      playlist: playlist(streamState?.playlist),
      accountKey:
        typeof streamState?.accountKey === "string"
          ? text(streamState.accountKey) || null
          : null,
      inspectedGroup:
        typeof streamState?.inspectedGroup === "string"
          ? text(streamState.inspectedGroup) || null
          : null,
      scrollTop: scroll(streamState?.scrollTop),
    },
  };
}

/**
 * source 只表示上次聚焦哪一栏；固定双栏时即使焦点在本地，右侧在线页也必须恢复。
 */
export function shouldRestoreStreamWorkspace(
  session: WorkspaceSession,
  localPanePinned: boolean,
): boolean {
  return Boolean(session.stream.playlist && (session.source === "stream" || localPanePinned));
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let cached: WorkspaceSession | null = null;

export function readWorkspaceSession(): WorkspaceSession {
  if (!cached) {
    try {
      cached = normalizeWorkspaceSession(
        JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "null"),
      );
    } catch {
      cached = normalizeWorkspaceSession(null);
    }
  }
  return structuredClone(cached);
}

function commit(next: WorkspaceSession): void {
  cached = normalizeWorkspaceSession(next);
  const value = JSON.stringify(cached);
  // 部分 Node 单测只提供最小 window/localStorage stub，没有浏览器 timer。
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    writeLocalStorageSoon(STORAGE_KEY, value, 300);
  } else {
    writeLocalStorageNow(STORAGE_KEY, value);
  }
}

export function setRestorableWorkspaceSource(source: RestorableWorkspaceSource): void {
  commit({ ...readWorkspaceSession(), source });
}

export function updateLocalWorkspaceSession(patch: Partial<LocalWorkspaceSession>): void {
  const current = readWorkspaceSession();
  commit({ ...current, local: { ...current.local, ...patch } });
}

export function updateStreamWorkspaceSession(
  patch: Partial<StreamWorkspaceSession>,
): void {
  const current = readWorkspaceSession();
  commit({ ...current, stream: { ...current.stream, ...patch } });
}
