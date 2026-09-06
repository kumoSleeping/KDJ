import { useAppStore } from "../stores/appStore";
import { useWorkshopStore } from "../stores/workshopStore";

/** Only local context menus call this. Reopening an existing panel does not enqueue anything. */
export async function enqueueLocalComposition(ids: number[], target?: string | "new"): Promise<void> {
  useAppStore.getState().openCompositionPanel();
  await useWorkshopStore.getState().flush();
  if (target === "new") {
    const previous = useWorkshopStore.getState().activeId;
    await useWorkshopStore.getState().createProject();
    if (useWorkshopStore.getState().activeId === previous) return;
  } else if (target) {
    await useWorkshopStore.getState().selectProject(target);
    if (useWorkshopStore.getState().activeId !== target) return;
  }
  await useWorkshopStore.getState().add(ids);
}
