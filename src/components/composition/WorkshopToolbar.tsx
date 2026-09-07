import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const WorkshopToolbarTarget = createContext<HTMLElement | null>(null);

/** Keep editor actions in the workspace chrome without moving editor state. */
export function WorkshopToolbar({ children }: { children: ReactNode }) {
  const target = useContext(WorkshopToolbarTarget);
  const toolbar = <header className="vj-header vj-workshop-toolbar" data-workshop-toolbar="" aria-label="工作站操作">{children}</header>;
  return target ? createPortal(toolbar, target) : toolbar;
}
