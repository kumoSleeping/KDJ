import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { settingsPages, useSettingsPage } from "../../lib/settingsPages";
import { useSidePanels } from "../../lib/sidePanels";
import { useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { studioTabs, useStudioTab } from "../../lib/visualizerStudioTabs";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useVisualizerStudioStore, VISUALIZER_DOCK_APP } from "../../stores/visualizerStudioStore";
import { VisualizerDock } from "../composition/VisualizerDock";
import { SlidePages } from "../drawer/SlidePages";
import type { DrawerSpec } from "../drawer/drawerSchema";
import { TrackMetaEditorDrawer } from "../library/TrackMetaEditor";
import { DrawerLyrics } from "../player/SidePanels";
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

/**
 * The apps the list's drawer can show that are opened from stores, each described by the drawer
 * schema (see docs/drawer-schema.md). Only open apps are listed; the workspace shows the one
 * asked for last and puts the others away.
 */
export function useDrawerApps(): DrawerSpec[] {
  const lyrics = useSidePanels(state => state.lyrics);
  const downloads = useSidePanels(state => state.downloads);
  const settings = useAppStore(state => state.showSettings);
  const taskView = useTaskPanelStore(state => state.view);
  const settingsPage = useSettingsPage(state => state.page);
  const visualizerTrack = useVisualizerStudioStore(state => state.track);
  const studioTab = useStudioTab(state => state.tab);
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
    close: () => useSidePanels.getState().setLyrics(false),
  });
  if (downloads) apps.push({
    id: "downloads",
    title: "下载与导出",
    extent: "content",
    pages: taskViews,
    page: taskView,
    onPage: id => useTaskPanelStore.getState().setView(id as TaskPanelView),
    body: <div className="kd-task-window kd-download-window kd-drawer-tasks"><DownloadTaskPages /></div>,
    close: () => useSidePanels.getState().setDownloads(false),
  });
  if (settings) apps.push({
    id: "settings",
    title: "设置",
    extent: "full",
    pages: settingsPages,
    page: settingsPage,
    onPage: id => useSettingsPage.getState().setPage(id as typeof settingsPage),
    body: <DrawerSettings />,
    close: () => useAppStore.getState().dismissOverlay(),
  });
  if (visualizerTrack) apps.push({
    id: VISUALIZER_DOCK_APP,
    title: "可视化配置",
    caption: songLine(visualizerTrack),
    extent: "full",
    pages: studioTabs,
    page: studioTab,
    onPage: id => useStudioTab.getState().setTab(id as typeof studioTab),
    body: <VisualizerDock />,
    close: () => useVisualizerStudioStore.getState().requestClose(),
  });
  if (metaId !== null) apps.push({
    id: "meta",
    title: "编辑 Meta",
    caption: songLine(metaTrack),
    extent: "content",
    body: <TrackMetaEditorDrawer />,
    close: () => useTrackMetaEditor.getState().close(),
  });
  return apps;
}
