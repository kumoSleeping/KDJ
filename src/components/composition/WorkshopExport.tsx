import { FolderOpen } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { cloneProject, projectDuration } from "../../lib/workshop";
import { NumberField } from "./WorkshopNumberField";
import type { CompositionProject } from "../../types/workshop";
export function WorkshopExportSettings() {
  const p = useWorkshopStore((s) => s.draft),
    jobs = useWorkshopStore((s) => s.jobs);
  if (!p) return null;
  const change = (f: (p: CompositionProject) => void) => {
    const state = useWorkshopStore.getState();
    if (!state.draft) return;
    const next = cloneProject(state.draft);
    f(next);
    state.transient(next);
  };
  const commit = () => useWorkshopStore.getState().commit();
  const job = [...jobs].reverse().find((j) => j.project_id === p.id),
    busy =
      job &&
      ["queued", "rendering", "validating", "committing", "importing"].includes(
        job.phase,
      );
  return (
    <details className="vj-export-settings"><summary>输出设置 · {p.canvas.width} × {p.canvas.height} · {p.canvas.fps.toFixed(2)} fps</summary>
      <fieldset disabled={Boolean(busy)}>
        <label className="vj-text-field">
          名称
          <input
            aria-label="导出名称"
            value={p.output.name}
            onChange={(e) =>
              change((p) => {
                p.output.name = e.target.value;
              })
            }
            onBlur={commit}
          />
        </label>
        <button
          type="button"
          className="vj-directory"
          title={p.output.directory}
          onClick={() => {
            void window.kdj
              ?.pickFolder()
              .then((dir) => {
                if (dir) {
                  change((p) => {
                    p.output.directory = dir;
                  });
                  commit();
                }
              })
              .catch((e) => useWorkshopStore.setState({ error: String(e) }));
          }}
        >
          <FolderOpen size={14} />
          <span>{p.output.directory}</span>
        </button>
        <label className="vj-check">
          <input
            type="checkbox"
            checked={p.output.out_ms !== null}
            onChange={(e) => {
              change((p) => {
                p.output.in_ms = 0;
                p.output.out_ms = e.target.checked ? projectDuration(p) : null;
              });
              commit();
            }}
          />
          指定导出区间
        </label>
        {p.output.out_ms !== null && (
          <div className="vj-duo">
            <NumberField
              label="导出入点"
              value={p.output.in_ms / 1000}
              min={0}
              max={p.output.out_ms / 1000 - 0.001}
              suffix="s"
              onChange={(v) =>
                change((p) => {
                  p.output.in_ms = v * 1000;
                })
              }
              onCommit={commit}
            />
            <NumberField
              label="导出出点"
              value={p.output.out_ms / 1000}
              min={p.output.in_ms / 1000 + 0.001}
              max={projectDuration(p) / 1000}
              suffix="s"
              onChange={(v) =>
                change((p) => {
                  p.output.out_ms = v * 1000;
                })
              }
              onCommit={commit}
            />
          </div>
        )}
        <details>
          <summary>高级</summary>
          <div className="vj-duo">
            <NumberField
              label="宽度"
              value={p.canvas.width}
              min={2}
              max={7680}
              step={2}
              onChange={(v) =>
                change((p) => {
                  p.canvas.width = Math.round(v / 2) * 2; p.canvas.initialized = true;
                })
              }
              onCommit={commit}
            />
            <NumberField
              label="高度"
              value={p.canvas.height}
              min={2}
              max={7680}
              step={2}
              onChange={(v) =>
                change((p) => {
                  p.canvas.height = Math.round(v / 2) * 2; p.canvas.initialized = true;
                })
              }
              onCommit={commit}
            />
          </div>
          <NumberField
            label="帧率"
            value={p.canvas.fps}
            min={1}
            max={120}
            step={1}
            onChange={(v) =>
              change((p) => {
                p.canvas.fps = v; p.canvas.initialized = true;
              })
            }
            onCommit={commit}
          />
          <label className="vj-text-field">
            质量
            <select
              aria-label="导出质量"
              value={p.output.quality}
              onChange={(e) => {
                change((p) => {
                  p.output.quality = Number(e.target.value);
                });
                commit();
              }}
            >
              <option value={16}>高</option>
              <option value={20}>标准</option>
              <option value={26}>紧凑</option>
            </select>
          </label>
          <label className="vj-text-field">
            编码
            <select
              aria-label="编码加速"
              value={p.output.acceleration}
              onChange={(e) => {
                change((p) => {
                  p.output.acceleration = e.target
                    .value as typeof p.output.acceleration;
                });
                commit();
              }}
            >
              {[
                ["auto", "自动"],
                ["software", "软件"],
                ["video_toolbox", "macOS 硬件"],
                ["nvidia", "NVIDIA"],
                ["intel", "Intel"],
                ["amd", "AMD"],
              ].map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </details>
      </fieldset>
    </details>
  );
}
