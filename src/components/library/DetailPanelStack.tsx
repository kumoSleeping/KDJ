import type { ReactNode } from "react";
import { FilePenLine, Music2, TextQuote, Video } from "lucide-react";
import { DETAIL_PANELS_DEFAULT_FIRST_IDS, DETAIL_PANELS_STORAGE_KEY, useDetailPanelPrefs } from "../../lib/detailPanelPrefs";
import { PanelStack } from "../common/PanelStack";

const iconProps = { size: 14, strokeWidth: 2.25, "aria-hidden": true } as const;
const panels = {
  information: { label: "曲目信息", icon: <Music2 {...iconProps} /> },
  lyrics: { label: "歌词", icon: <TextQuote {...iconProps} /> },
  video: { label: "视频", icon: <Video {...iconProps} /> },
  metadata: { label: "曲目信息编辑", icon: <FilePenLine {...iconProps} /> },
};

export function DetailPanelStack({ children, restoreTarget, preview = false, video = false }: {
  children: ReactNode;
  restoreTarget: HTMLElement | null;
  preview?: boolean;
  video?: boolean;
}) {
  const items = video ? { ...panels, information: { label: "视频信息", icon: <Video {...iconProps} /> } } : panels;
  const hiddenIds = useDetailPanelPrefs(state => state.hiddenIds);
  const setVisible = useDetailPanelPrefs(state => state.setVisible);
  if (preview) return <PanelStack reorderable storageKey="kd-track-preview-panels"
    index={{ panels: items, target: restoreTarget }}>{children}</PanelStack>;
  return <PanelStack reorderable storageKey={DETAIL_PANELS_STORAGE_KEY} defaultFirstIds={DETAIL_PANELS_DEFAULT_FIRST_IDS}
    index={{ panels: items, target: restoreTarget }}
    collapse={{ panels: items, restoreTarget, hiddenIds, setVisible }}>{children}</PanelStack>;
}
