import { TurnContents } from "../common/TurnContents";
import { LyricsPresentation } from "./LyricsPresentation";
import { useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { PanelCollapseContext, PanelDockedContext } from "../common/panelCollapse";
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

/** The lyrics as the body of a drawer: the drawer writes the title and puts it away. */
export function DrawerLyrics() {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  return <LyricsPresentation><TurnContents className="kd-lyrics-turn" changeKey={String(track?.id ?? "")}><section className="kd-side-panels kd-drawer-lyrics">
    {track && <PanelDockedContext.Provider value><LyricsDetailPanel key={track.id} track={track} reserveEmpty /></PanelDockedContext.Provider>}
  </section></TurnContents></LyricsPresentation>;
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
    {lyrics && track && <LyricsPresentation><TurnContents className="kd-lyrics-turn" changeKey={String(track.id)}><PanelCollapseContext.Provider
      value={{ label: "歌词", collapse: () => useSidePanels.getState().setLyrics(false) }}>
      <LyricsDetailPanel key={track.id} track={track} reserveEmpty visibleHeader />
    </PanelCollapseContext.Provider></TurnContents></LyricsPresentation>}
    {downloads && <PanelCollapseContext.Provider
      value={{ label: "下载与导出", collapse: () => useSidePanels.getState().setDownloads(false) }}>
      <DownloadTaskPanel />
    </PanelCollapseContext.Provider>}
  </section>;
}
