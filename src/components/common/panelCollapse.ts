import { createContext } from "react";

export const PanelCollapseContext = createContext<{
  label: string;
  collapse(): void;
} | null>(null);

/** True for a panel placed directly in a stack: built-in themes drop its title row. */
export const PanelDockedContext = createContext(false);
