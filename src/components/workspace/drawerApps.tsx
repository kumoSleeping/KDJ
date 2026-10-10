import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Download, Settings, TextQuote } from "lucide-react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { settingsPages, useSettingsPage, type SettingsPage } from "../../lib/settingsPages";
import { useSidePanels } from "../../lib/sidePanels";
import { useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { visualizerExportActive } from "../../lib/visualizerExportQueue";
import { studioTabs, useStudioTab, type StudioTab } from "../../lib/visualizerStudioTabs";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useVisualizerStudioStore, VISUALIZER_DOCK_APP } from "../../stores/visualizerStudioStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import { VisualizerDock } from "../composition/VisualizerDock";
import { SlidePages } from "../drawer/SlidePages";
import type { DrawerEntry, DrawerSpec } from "../drawer/drawerSchema";
import { TrackMetaEditorDrawer } from "../library/TrackMetaEditor";
import { DrawerLyrics } from "../player/SidePanels";
import { SongColorBackdrop } from "../player/SongColorBackdrop";
import { requestPlayingLyrics } from "../player/lyricsEntry";
import { DownloadTaskPages, taskViews } from "../player/TaskPanels";
import { SettingsPanel } from "../settings/SettingsPanel";

const settingsPageIds = settingsPages.map(page => page.id);

/** The settings sections of one page; a page starts at its top. */
function DrawerSettings() {
  const page = useSettingsPage(state => state.page);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { host.current?.querySelector(".kd-scroll")?.scrollTo({ top: 0 }); }, [page]);
  return <SlidePages page={page} order={settingsPageIds}>
    <div ref={host} className="kd-drawer-settings"><SettingsPanel preferences page={page} /></div>
  </SlidePages>;
}

const songLine = (track: { title?: string | null; filename?: string | null; artist?: string | null } | null | undefined) => {
  if (!track) return undefined;
  const name = track.title || track.filename || "";
  return track.artist ? `${name} · ${track.artist}` : name || undefined;
};

// The page in view of each app with pages. The drawer's title row calls these itself, so a
// switch of page is not a change of the workspace that lists the apps.
const useTaskView = () => useTaskPanelStore(state => state.view);
const useSettingsPageInView = () => useSettingsPage(state => state.page);
const useStudioTabInView = () => useStudioTab(state => state.tab);

/**
 * The apps the list's drawer can show that are opened from stores, each described by the drawer
 * schema (see docs/drawer-schema.md). Only open apps are listed; the workspace shows the one
 * asked for last and puts the others away.
 */
export function useDrawerApps(): DrawerSpec[] {
  const lyrics = useSidePanels(state => state.lyrics);
  const downloads = useSidePanels(state => state.downloads);
  const settings = useAppStore(state => state.showSettings);
  const visualizerTrack = useVisualizerStudioStore(state => state.track);
  const metaId = useTrackMetaEditor(state => state.trackId);
  const metaTrack = useLibraryStore(state => metaId === null ? undefined : state.summaryById.get(metaId));
  const playing = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const apps: DrawerSpec[] = [];
  if (lyrics) apps.push({
    id: "lyrics",
    title: "歌词",
    caption: songLine(playing),
    extent: "two-thirds",
    body: <DrawerLyrics />,
    backdrop: <SongColorBackdrop surface="lyrics" />,
    close: () => useSidePanels.getState().setLyrics(false),
  });
  if (downloads) apps.push({
    id: "downloads",
    title: "下载与导出",
    // Things are dropped on its blank space, so it keeps room even while it lists nothing.
    extent: "at-least-half",
    pages: taskViews,
    usePage: useTaskView,
    onPage: id => useTaskPanelStore.getState().setView(id as TaskPanelView),
    body: <div className="kd-task-window kd-download-window kd-drawer-tasks"><DownloadTaskPages /></div>,
    close: () => useSidePanels.getState().setDownloads(false),
  });
  if (settings) apps.push({
    id: "settings",
    title: "设置",
    extent: "fit",
    pages: settingsPages,
    usePage: useSettingsPageInView,
    onPage: id => useSettingsPage.getState().setPage(id as SettingsPage),
    body: <DrawerSettings />,
    close: () => useAppStore.getState().dismissOverlay(),
  });
  if (visualizerTrack) apps.push({
    id: VISUALIZER_DOCK_APP,
    title: "可视化配置",
    caption: songLine(visualizerTrack),
    extent: "fit",
    pages: studioTabs,
    usePage: useStudioTabInView,
    onPage: id => useStudioTab.getState().setTab(id as StudioTab),
    body: <VisualizerDock />,
    close: () => useVisualizerStudioStore.getState().requestClose(),
  });
  if (metaId !== null) apps.push({
    id: "meta",
    title: "编辑 Meta",
    caption: songLine(metaTrack),
    extent: "fit",
    body: <TrackMetaEditorDrawer />,
    close: () => useTrackMetaEditor.getState().close(),
  });
  return apps;
}

/** An export that is waiting or being written. */
const exportRunning = (phase: string) => ["queued", "rendering", "validating", "committing", "importing"].includes(phase);

/**
 * What the drawer's head offers while it is rolled up: the apps that are opened by hand. The
 * ids are those of the apps in `useDrawerApps`. 下载 carries the number of downloads and
 * exports that are under way.
 */
export function useDrawerEntries(): DrawerEntry[] {
  const downloading = useDownloadStore(state => state.activeCount);
  const exporting = useWorkshopStore(state => state.jobs.reduce((count, job) => count + (exportRunning(job.phase) ? 1 : 0), 0));
  const rendering = useVisualizerExportStore(state => state.tasks.reduce((count, task) => count + (visualizerExportActive(task) ? 1 : 0), 0));
  const running = downloading + exporting + rendering;
  return useMemo(() => [
    {
      id: "downloads",
      label: "下载",
      title: "下载与导出",
      icon: <Download size={15} aria-hidden="true" />,
      count: running,
      open: () => useSidePanels.getState().setDownloads(true),
    },
    {
      id: "lyrics",
      label: "歌词",
      icon: <TextQuote size={15} aria-hidden="true" />,
      // No lyrics: a small note says so; an empty panel does not come out.
      open: () => requestPlayingLyrics(),
    },
    {
      id: "settings",
      label: "设置",
      icon: <Settings size={15} aria-hidden="true" />,
      open: () => useAppStore.getState().openSettingsPanel(),
    },
  ], [running]);
}
