import { createContext, type RefCallback } from "react";

/** The shared video controls register a picture-local host for panel management. */
export const PanelMediaControlsContext = createContext<RefCallback<HTMLDivElement> | null>(null);
