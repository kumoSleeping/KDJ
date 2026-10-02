import { createContext } from "react";

/** Expanded playback panels host library actions in their own left-hand rail. */
export const LibraryWorkRailToolsTargetContext = createContext<HTMLElement | null>(null);
