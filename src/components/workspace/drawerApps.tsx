import { useLayoutEffect, useMemo, useRef } from "react";
import { Download, Settings, Sparkles, TextQuote } from "lucide-react";
import { AI_DRAWER_APP, aiDrawerPages, useAiDrawer, type AiDrawerPage } from "../../lib/aiDrawer";
import { shownLyricsExtent, useLyricsExtent, useLyricsExtentShape } from "../../lib/lyricsExtent";
import type { PlayingLyrics } from "../../lib/playingLyrics";
import { shownSettingsPages, useSettingsPage, type SettingsPage } from "../../lib/settingsPages";
import { useSidePanels } from "../../lib/sidePanels";
import { useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { visualizerExportActive } from "../../lib/visualizerExportQueue";
import { shownStudioTabs, useStudioTab, type StudioTab } from "../../lib/visualizerStudioTabs";
import { aiOffered } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useVisualizerStudioStore, VISUALIZER_DOCK_APP } from "../../stores/visualizerStudioStore";
import { VisualizerDock } from "../composition/VisualizerDock";
import { SlidePages } from "../drawer/SlidePages";
import type { DrawerEntry, DrawerSpec, TitleDrop } from "../drawer/drawerSchema";
import { downloadIntoEditor } from "../../lib/editorDownloads";
import { isProjectTrack } from "../../lib/format";
import { useLibraryStore } from "../../stores/libraryStore";
import { AiDrawer, AiDrawerTools } from "../ai/AiDrawer";
import { LaneEditor } from "../editor/LaneEditor";
import { LANE_EDITOR_APP, useLaneEditor } from "../../stores/laneEditorStore";
import { api } from "../../lib/api";
import type { Track } from "../../types";
import { TrackMetaEditorDrawer } from "../library/TrackMetaEditor";
import { DrawerLyrics } from "../player/SidePanels";
import { SongColorBackdrop } from "../player/SongColorBackdrop";
import { requestPlayingLyrics } from "../player/lyricsEntry";
import { mediaProductionAvailable } from "../../lib/platformFeatures";
import { DownloadTaskPages, shownTaskViews } from "../player/TaskPanels";
import { SettingsPanel } from "../settings/SettingsPanel";

/** The settings sections of one page; a page starts at its top. */
function DrawerSettings() {
  const page = useSettingsPage(state => state.page);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { host.current?.querySelector(".kd-scroll")?.scrollTo({ top: 0 }); }, [page]);
  return <SlidePages page={page} order={shownSettingsPages().map(item => item.id)}>
    <div ref={host} className="kd-drawer-settings"><SettingsPanel preferences page={page} /></div>
  </SlidePages>;
}

// The page in view of each app with pages. The drawer's title row calls these itself, so a
// switch of page is not a change of the workspace that lists the apps.
const useTaskView = () => useTaskPanelStore(state => state.view);
const useSettingsPageInView = () => useSettingsPage(state => state.page);
const useStudioTabInView = () => useStudioTab(state => state.tab);
const useAiPageInView = () => useAiDrawer(state => state.page);
const useProjectInView = () => useLaneEditor(state => state.active ?? "");

/**
 * On the editor's title: songs or videos (from the library, or online ones, downloaded first)
 * start another project, another page; a project opens as its page, or is shown when it is open.
 */
const NEW_PROJECT_DROP: TitleDrop = {
  label: "新建一个工程",
  labelFor(ids) {
    const byId = useLibraryStore.getState().summaryById;
    return ids.length > 0 && ids.every(id => isProjectTrack(byId.get(id)?.format ?? "")) ? "打开工程" : "新建一个工程";
  },
  drop(ids) {
    void Promise.all(ids.map(id => api.track(id).catch(() => null)))
      .then(tracks => useLaneEditor.getState().placeTracks(null, tracks.filter((t): t is Track => Boolean(t)), { at: 0 }));
  },
  dropSearch: payload => {
    useLaneEditor.getState().show();
    void downloadIntoEditor(payload, null, 0);
  },
};

/** Full-screen lyrics give the window back by becoming the longer drawer again. */
const LYRICS_WINDOW = { label: "退出全屏", leave: () => useLyricsExtent.getState().setExtent("longer") };

/**
 * The apps the list's drawer can show that are opened from stores, each described by the drawer
 * schema (see docs/drawer-schema.md). Only open apps are listed; the workspace shows the one
 * asked for last and puts the others away.
 */
export function useDrawerApps(lyricsSong: PlayingLyrics): DrawerSpec[] {
  const lyrics = useSidePanels(state => state.lyrics);
  const downloads = useSidePanels(state => state.downloads);
  const settings = useAppStore(state => state.showSettings);
  const visualizerTrack = useVisualizerStudioStore(state => state.track);
  const metaId = useTrackMetaEditor(state => state.trackId);
  const ai = useAiDrawer(state => state.open);
  const laneEditor = useLaneEditor(state => state.open);
  const laneProjects = useLaneEditor(state => state.projects);
  const projectPages = useMemo(() => laneProjects.map(p => ({ id: p.path, label: p.doc.title || "未命名", title: `${p.doc.title || "未命名"} · ${p.path}` })), [laneProjects]);
  // How tall the lyrics are is the listener's choice (the menu on the panel, lyricsExtent.ts).
  // Full screen needs a song: the playing song's bubble is the other half of that window.
  const lyricsExtent = shownLyricsExtent(useLyricsExtent(state => state.extent), useLyricsExtentShape());
  const apps: DrawerSpec[] = [];
  if (lyrics) apps.push({
    id: "lyrics",
    contentKey: lyricsSong.track?.id,
    suspended: !lyricsSong.visible,
    title: "歌词",
    extent: lyricsExtent === "standard" ? "two-thirds" : "full",
    takesWindow: lyricsExtent === "full" && lyricsSong.visible ? LYRICS_WINDOW : undefined,
    body: lyricsSong.track ? <DrawerLyrics track={lyricsSong.track} /> : null,
    backdrop: <SongColorBackdrop surface="lyrics" />,
    close: () => useSidePanels.getState().setLyrics(false),
  });
  if (downloads) apps.push({
    id: "downloads",
    title: mediaProductionAvailable() ? "下载与导出" : "下载",
    // Things are dropped on its blank space, so it keeps room even while it lists nothing.
    extent: "at-least-half",
    pages: shownTaskViews(),
    usePage: useTaskView,
    onPage: id => useTaskPanelStore.getState().setView(id as TaskPanelView),
    body: <div className="kd-task-window kd-download-window kd-drawer-tasks"><DownloadTaskPages /></div>,
    close: () => useSidePanels.getState().setDownloads(false),
  });
  if (settings) apps.push({
    id: "settings",
    title: "设置",
    extent: "fit",
    pages: shownSettingsPages(),
    usePage: useSettingsPageInView,
    onPage: id => useSettingsPage.getState().setPage(id as SettingsPage),
    body: <DrawerSettings />,
    close: () => useAppStore.getState().dismissOverlay(),
  });
  if (visualizerTrack) apps.push({
    id: VISUALIZER_DOCK_APP,
    title: "可视化配置",
    extent: "fit",
    pages: shownStudioTabs(),
    usePage: useStudioTabInView,
    onPage: id => useStudioTab.getState().setTab(id as StudioTab),
    body: <VisualizerDock />,
    close: () => useVisualizerStudioStore.getState().requestClose(),
  });
  if (ai) apps.push({
    id: AI_DRAWER_APP,
    title: "AI",
    extent: "at-least-half",
    pages: aiDrawerPages,
    usePage: useAiPageInView,
    onPage: id => useAiDrawer.getState().setPage(id as AiDrawerPage),
    tools: <AiDrawerTools />,
    body: <AiDrawer />,
    close: () => useAiDrawer.getState().close(),
  });
  if (mediaProductionAvailable() && laneEditor) apps.push({
    id: LANE_EDITOR_APP,
    title: "剪辑",
    extent: "at-least-half",
    // One page per open project; nothing open yet, the plain title.
    pages: projectPages.length ? projectPages : undefined,
    usePage: projectPages.length ? useProjectInView : undefined,
    onPage: id => useLaneEditor.getState().activate(id),
    // Each project closes by its own ×; what it is is already saved, edit by edit, in its file.
    closePage: path => useLaneEditor.getState().closeProject(path),
    // A double-click on a project's word renames it: its file, its title and its library row.
    renamePage: (path, name) => { void useLaneEditor.getState().renameProject(path, name); },
    titleDrop: NEW_PROJECT_DROP,
    body: <LaneEditor />,
    close: () => useLaneEditor.getState().close(),
  });
  if (metaId !== null) apps.push({
    id: "meta",
    title: "编辑 Meta",
    extent: "fit",
    body: <TrackMetaEditorDrawer />,
    close: () => useTrackMetaEditor.getState().close(),
  });
  return apps;
}

/**
 * What the drawer's head offers while it is rolled up: the apps that are opened by hand. The
 * ids are those of the apps in `useDrawerApps`. 下载 carries the number of downloads and
 * exports that are under way.
 */
export function useDrawerEntries(): DrawerEntry[] {
  const downloading = useDownloadStore(state => state.activeCount);
  const rendering = useVisualizerExportStore(state => state.tasks.reduce((count, task) => count + (visualizerExportActive(task) ? 1 : 0), 0));
  const running = downloading + rendering;
  return useMemo(() => [
    {
      id: "downloads",
      label: "下载",
      title: mediaProductionAvailable() ? "下载与导出" : "下载",
      icon: <Download size={15} aria-hidden="true" />,
      count: running,
      open: () => useSidePanels.getState().setDownloads(true),
    },
    {
      id: "lyrics",
      label: "歌词",
      icon: <TextQuote size={15} aria-hidden="true" />,
      // No lyrics: a small note says so, under this entry; an empty panel does not come out.
      open: () => requestPlayingLyrics(undefined, "top"),
    },
    ...(aiOffered() ? [{
      id: AI_DRAWER_APP,
      label: "AI",
      title: "AI 任务与历史",
      icon: <Sparkles size={15} aria-hidden="true" />,
      open: () => useAiDrawer.getState().show(),
    }] : []),
    {
      id: "settings",
      label: "设置",
      icon: <Settings size={15} aria-hidden="true" />,
      open: () => useAppStore.getState().openSettingsPanel(),
    },
  ], [running]);
}
