import { useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { PanelCollapseContext } from "../common/panelCollapse";
import { DownloadTaskPanel } from "./TaskPanels";
import { LyricsDetailPanel } from "./LyricsView";
import "./SidePanels.css";

/** The right column: lyrics opened from 曲目信息, and the task list opened from the top bar. */
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
