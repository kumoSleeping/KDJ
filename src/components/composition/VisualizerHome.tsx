import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { visualizerExportActive, visualizerExportStartable } from "../../lib/visualizerExportQueue";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { InlineNotice } from "../common/InlineNotice";
import { VisualizerExportTasks } from "./VisualizerExportTasks";
import { WorkshopToolbar, WorkshopToolbarTarget } from "./WorkshopToolbar";
import { WorkshopVisualizerAction } from "./WorkshopVisualizerAction";

export function VisualizerHome({toolbarTarget}: {toolbarTarget?: HTMLElement | null}) {
  const error = useVisualizerExportStore(s => s.error);
  const tasks = useVisualizerExportStore(s => s.tasks);
  const [canceling, setCanceling] = useState(false);
  useEffect(() => { void useVisualizerExportStore.getState().initialize().catch(() => undefined); }, []);
  return <WorkshopToolbarTarget.Provider value={toolbarTarget ?? null}>
    <section className="vj-workshop vj-task-list" aria-label="可视化视频">
      <WorkshopToolbar>
        <WorkshopVisualizerAction />
        <span className="vj-spacer" />
        <button type="button" disabled={!tasks.some(visualizerExportStartable)} onClick={() => useVisualizerExportStore.getState().start()}><Download size={14}/>全部导出</button>
        {tasks.some(visualizerExportActive) && <button type="button" disabled={canceling} onClick={() => {
          setCanceling(true);
          void useVisualizerExportStore.getState().cancel().catch(e => useVisualizerExportStore.setState({error: String(e)})).finally(() => setCanceling(false));
        }}>{canceling ? "正在取消" : "全部取消"}</button>}
      </WorkshopToolbar>
      <InlineNotice text={error} onDismiss={() => useVisualizerExportStore.setState({error: ""})}/>
      <div className="vj-task-stack"><VisualizerExportTasks /></div>
    </section>
  </WorkshopToolbarTarget.Provider>;
}
