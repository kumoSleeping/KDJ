import { createContext, type RefCallback } from "react";

export const PlaybackPanelIndexTargetContext = createContext<RefCallback<HTMLSpanElement> | null>(null);
