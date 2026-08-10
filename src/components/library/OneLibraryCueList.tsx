import { cueColor, cueColorLabel, cueTimeRange, cueTypeLabel, hotCueLabel } from "../../lib/cuePoints";
import type { CuePoint } from "../../types";

/** OneLibrary Cue 的纯只读表；空数组不渲染占位或提示。 */
export function OneLibraryCueList({ cuePoints }: { cuePoints: readonly CuePoint[] }) {
  if (cuePoints.length === 0) return null;
  return (
    <div className="kd-onelibrary-cue-list">
      <table aria-label="Cue 与 Loop">
        <thead>
          <tr>
            <th>类型</th>
            <th>时间</th>
            <th>颜色</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {cuePoints.map((cue) => {
            const hot = hotCueLabel(cue.hot_cue);
            const colorLabel = cueColorLabel(cue);
            return (
              <tr key={cue.id}>
                <td>
                  <span className="kd-onelibrary-cue-type">
                    <i data-kind={hot ? "hot" : "memory"} style={{ background: cueColor(cue) }}>
                      {hot || "M"}
                    </i>
                    <span>{cueTypeLabel(cue)}</span>
                    {cue.active_loop ? <small>激活</small> : null}
                  </span>
                </td>
                <td className="kd-mono kd-nowrap">{cueTimeRange(cue)}</td>
                <td>
                  {colorLabel ? (
                    <span className="kd-onelibrary-cue-color">
                      <i style={{ background: cueColor(cue) }} />
                      {colorLabel}
                    </span>
                  ) : null}
                </td>
                <td className="kd-truncate" title={cue.comment || undefined}>
                  {cue.comment}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
