import { PanelDockedContext } from "../common/panelCollapse";
import { useLyricsExtentMenu } from "./LyricsExtentMenu";
import { PlayingLyricsPanel } from "./LyricsView";
import type { Track } from "../../types";
import "./SidePanels.css";

/**
 * The lyrics as the body of a drawer: the drawer writes the title and puts it away. A right
 * click or a long press on it offers how tall the lyrics are (LyricsExtentMenu).
 */
export function DrawerLyrics({ track }: { track: Track }) {
  // A leaving drawer keeps this song, rather than following the live playing-track store.
  const extent = useLyricsExtentMenu();
  return <section className="kd-side-panels kd-drawer-lyrics" {...extent.props}>
    <PanelDockedContext.Provider value><PlayingLyricsPanel track={track} /></PanelDockedContext.Provider>
    {extent.menu}
  </section>;
}

