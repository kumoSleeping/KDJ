import { writeLocalStorageSoon } from "./storageWrite";

const STORAGE_KEY = "kd-sidebar-tree-state-v1";
const MAX_ITEMS = 2_000;
const MAX_KEY_LENGTH = 4_096;

export interface SidebarTreeState {
  version: 1;
  local: {
    expanded: string[];
    knownRoots: string[];
  };
  oneLibrary: {
    open: boolean;
    openDevices: string[];
    openFolders: string[];
    knownDevices: string[];
  };
}

export const DEFAULT_SIDEBAR_TREE_STATE: SidebarTreeState = {
  version: 1,
  local: { expanded: [], knownRoots: [] },
  oneLibrary: {
    open: true,
    openDevices: [],
    openFolders: [],
    knownDevices: [],
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      item.length > 0 &&
      item.length <= MAX_KEY_LENGTH &&
      !result.includes(item)
    ) {
      result.push(item);
      if (result.length >= MAX_ITEMS) break;
    }
  }
  return result;
}

export function normalizeSidebarTreeState(value: unknown): SidebarTreeState {
  const root = record(value);
  const local = record(root?.local);
  const oneLibrary = record(root?.oneLibrary);
  return {
    version: 1,
    local: {
      expanded: stringList(local?.expanded),
      knownRoots: stringList(local?.knownRoots),
    },
    oneLibrary: {
      open: typeof oneLibrary?.open === "boolean" ? oneLibrary.open : true,
      openDevices: stringList(oneLibrary?.openDevices),
      openFolders: stringList(oneLibrary?.openFolders),
      knownDevices: stringList(oneLibrary?.knownDevices),
    },
  };
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let cached: SidebarTreeState | null = null;

export function readSidebarTreeState(): SidebarTreeState {
  if (!cached) {
    try {
      cached = normalizeSidebarTreeState(
        JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "null"),
      );
    } catch {
      cached = normalizeSidebarTreeState(null);
    }
  }
  return {
    version: 1,
    local: {
      expanded: [...cached.local.expanded],
      knownRoots: [...cached.local.knownRoots],
    },
    oneLibrary: {
      open: cached.oneLibrary.open,
      openDevices: [...cached.oneLibrary.openDevices],
      openFolders: [...cached.oneLibrary.openFolders],
      knownDevices: [...cached.oneLibrary.knownDevices],
    },
  };
}

function commit(next: SidebarTreeState): void {
  cached = normalizeSidebarTreeState(next);
  writeLocalStorageSoon(STORAGE_KEY, JSON.stringify(cached), 250);
}

export function writeLocalFolderTreeState(
  expanded: Iterable<string>,
  knownRoots: Iterable<string>,
): void {
  const current = readSidebarTreeState();
  commit({
    ...current,
    local: {
      expanded: [...expanded],
      knownRoots: [...knownRoots],
    },
  });
}

export function writeOneLibraryTreeState(
  state: SidebarTreeState["oneLibrary"],
): void {
  const current = readSidebarTreeState();
  commit({ ...current, oneLibrary: state });
}
