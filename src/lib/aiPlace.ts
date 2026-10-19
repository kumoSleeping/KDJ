/**
 * Where the listener was when the AI's task began, and putting it back (docs/ai-dock.md).
 *
 * The AI's searches move the window as a side effect: the search pane shows what it searched
 * and the library what it looked up (aiSearch.ts). When the task ends and the listener has not
 * moved the window meanwhile, it goes back to where they were — the whole library or the folder
 * that was open, the search pane's list, the library's search words and the field's words. This
 * is the window's own doing, not the AI's.
 *
 * Whatever the listener does during the task stays: they come first, nothing is put back, and
 * the AI is told (aiStore.noteUserChange). A change of place counts as the AI's while one of its
 * searches or lookups is being carried out (`beginAiMove`) and briefly after, until the place it
 * lands on has been committed to the history (navStore); every other change is the listener's.
 */
import { useAiStore } from "../stores/aiStore";
import { useLibraryStore, type LibraryFilter } from "../stores/libraryStore";
import { applyPlace, readPlace, samePlace, useNavStore, type Place } from "../stores/navStore";

const LOOKUP = ["q", "key", "bpmMin", "bpmMax", "energyMin"] as const;
type Lookup = Pick<LibraryFilter, (typeof LOOKUP)[number]>;

/** Workspace commits a place 40 ms after it lands; this covers that and the render before it. */
const SETTLE_MS = 300;

/** The search field's words, which Workspace owns. */
export interface SearchText {
  read(): string;
  write(text: string): void;
}

let searchText: SearchText | null = null;

/** Workspace registers its field while mounted; returns the unregister. */
export function registerSearchText(text: SearchText): () => void {
  searchText = text;
  return () => {
    if (searchText === text) searchText = null;
  };
}

type Task = {
  place: Place;
  lookup: Lookup;
  text: string;
  /** The AI moved the window at least once. */
  aiMoved: boolean;
  listenerMoved: boolean;
  /** The words the AI last put in the search field. */
  aiText: string | null;
  stop: () => void;
};

let task: Task | null = null;
let moving = 0;

const lookupOf = (filter: LibraryFilter): Lookup => ({
  q: filter.q,
  key: filter.key,
  bpmMin: filter.bpmMin,
  bpmMax: filter.bpmMax,
  energyMin: filter.energyMin,
});

const sameLookup = (a: Lookup, b: Lookup) => LOOKUP.every(field => a[field] === b[field]);

/** What the listener did, in words for the AI; null for what does not concern it (a panel). */
function describe(was: Place, now: Place): string | null {
  if (was.folder !== now.folder) return now.folder ? `用户打开了文件夹 ${now.folder}` : "用户回到了全部曲库";
  // The listener's own search is told where it is sent (Workspace), with its words.
  if (was.search !== now.search) return null;
  if (was.pane !== now.pane && now.pane === "local") return "用户切到了本地曲库";
  if (was.pane !== now.pane && now.pane === "search") return "用户切到了搜索页";
  return null;
}

function listenerMoved(change: string | null) {
  if (!task) return;
  task.listenerMoved = true;
  if (change) useAiStore.getState().noteUserChange(change);
}

/** A task begins: where the listener is now is kept. A task already under way keeps its start. */
export function aiTaskBegan(): void {
  if (task) return;
  const stopNav = useNavStore.subscribe((state, prev) => {
    if (!state.present || !prev.present || state.present === prev.present) return;
    if (samePlace(state.present, prev.present) || moving > 0) return;
    listenerMoved(describe(prev.present, state.present));
  });
  const stopLibrary = useLibraryStore.subscribe((state, prev) => {
    if (state.filter === prev.filter || moving > 0) return;
    if (sameLookup(lookupOf(state.filter), lookupOf(prev.filter))) return;
    listenerMoved(state.filter.q && state.filter.q !== prev.filter.q
      ? `用户在曲库里搜索了「${state.filter.q}」`
      : "用户改了曲库的筛选");
  });
  task = {
    place: readPlace(),
    lookup: lookupOf(useLibraryStore.getState().filter),
    text: searchText?.read() ?? "",
    aiMoved: false,
    listenerMoved: false,
    aiText: null,
    stop: () => {
      stopNav();
      stopLibrary();
    },
  };
}

/**
 * One of the AI's searches or lookups is being carried out in the window; call the returned
 * function when it has been (it may be called more than once). `text` is what it wrote in the
 * search field, if anything.
 */
export function beginAiMove(text?: string): () => void {
  moving += 1;
  if (task) {
    task.aiMoved = true;
    if (text !== undefined) task.aiText = text;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    setTimeout(() => {
      moving -= 1;
    }, SETTLE_MS);
  };
}

/** The task has ended: if the window is still where the AI left it, it goes back. */
export function aiTaskEnded(): void {
  const ended = task;
  if (!ended) return;
  task = null;
  ended.stop();
  if (!ended.aiMoved || ended.listenerMoved) return;
  // A move of the AI's that is still settling settles first; a search still on its way is
  // dropped when its pane closes (Workspace's closeResults).
  setTimeout(() => {
    if (task) return;
    if (!samePlace(readPlace(), ended.place)) applyPlace(ended.place);
    const library = useLibraryStore.getState();
    if (!sameLookup(lookupOf(library.filter), ended.lookup)) library.setFilter(ended.lookup);
    if (searchText && ended.aiText !== null && searchText.read() === ended.aiText) searchText.write(ended.text);
  }, SETTLE_MS);
}
