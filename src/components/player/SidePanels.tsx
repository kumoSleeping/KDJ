import { useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { PanelCollapseContext } from "../common/panelCollapse";
import { DownloadTaskPanel } from "./TaskPanels";
import { LyricsDetailPanel } from "./LyricsView";
import "./SidePanels.css";

/** The lyrics as one app of the right column. */
export function SideLyrics() {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  return <section className="kd-side-panels" aria-label="歌词">
    {track && <PanelCollapseContext.Provider
      value={{ label: "歌词", collapse: () => useSidePanels.getState().setLyrics(false) }}>
      <LyricsDetailPanel track={track} reserveEmpty visibleHeader />
    </PanelCollapseContext.Provider>}
  </section>;
}

/** The download and export task list as one app of the right column. */
export function SideDownloads() {
  return <section className="kd-side-panels" aria-label="下载与导出">
    <PanelCollapseContext.Provider
      value={{ label: "下载与导出", collapse: () => useSidePanels.getState().setDownloads(false) }}>
      <DownloadTaskPanel />
    </PanelCollapseContext.Provider>
  </section>;
}

/** Phone layout: both in one drawer, lyrics above the task list. */
export function SidePanels() {
  const downloads = useSidePanels(state => state.downloads);
  const lyrics = useSidePanels(state => state.lyrics);
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  return <section className="kd-side-panels" aria-label="侧栏">
    {lyrics && track && <PanelCollapseContext.Provider
      value={{ label: "歌词", collapse: () => useSidePanels.getState().setLyrics(false) }}>
      <LyricsDetailPanel track={track} reserveEmpty visibleHeader />
    </PanelCollapseContext.Provider>}
    {downloads && <PanelCollapseContext.Provider
      value={{ label: "下载与导出", collapse: () => useSidePanels.getState().setDownloads(false) }}>
      <DownloadTaskPanel />
    </PanelCollapseContext.Provider>}
  </section>;
}
