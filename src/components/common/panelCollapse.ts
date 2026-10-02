import { createContext } from "react";

export const PanelCollapseContext = createContext<{
  label: string;
  collapse(): void;
} | null>(null);
