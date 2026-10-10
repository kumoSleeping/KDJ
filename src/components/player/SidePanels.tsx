import { useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { PanelCollapseContext, PanelDockedContext } from "../common/panelCollapse";
import { DownloadTaskPanel } from "./TaskPanels";
import { useLyricsExtentMenu } from "./LyricsExtentMenu";
import { PlayingLyricsPanel } from "./LyricsView";
import "./SidePanels.css";

/** The lyrics as one app of the right column. */
export function SideLyrics() {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  return <section className="kd-side-panels" aria-label="歌词">
    <PanelCollapseContext.Provider
      value={{ label: "歌词", collapse: () => useSidePanels.getState().setLyrics(false) }}>
      <PlayingLyricsPanel track={track} visibleHeader />
    </PanelCollapseContext.Provider>
  </section>;
}

/**
 * The lyrics as the body of a drawer: the drawer writes the title and puts it away. A right
 * click or a long press on it offers how tall the lyrics are (LyricsExtentMenu).
 */
export function DrawerLyrics() {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const extent = useLyricsExtentMenu();
  return <section className="kd-side-panels kd-drawer-lyrics" {...extent.props}>
    <PanelDockedContext.Provider value><PlayingLyricsPanel track={track} /></PanelDockedContext.Provider>
    {extent.menu}
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
    {lyrics && <PanelCollapseContext.Provider
      value={{ label: "歌词", collapse: () => useSidePanels.getState().setLyrics(false) }}>
      <PlayingLyricsPanel track={track} visibleHeader />
    </PanelCollapseContext.Provider>}
    {downloads && <PanelCollapseContext.Provider
      value={{ label: "下载与导出", collapse: () => useSidePanels.getState().setDownloads(false) }}>
      <DownloadTaskPanel />
    </PanelCollapseContext.Provider>}
  </section>;
}
