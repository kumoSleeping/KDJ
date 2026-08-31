import { SEARCH_TIPS } from "./SearchBar";
import { HintBulbIcon } from "./HintBulbIcon";

/**
 * 搜索框轮播文案的完整索引。
 *
 * 它只负责展示，不持久化任何打开状态；Workspace 会把它当作临时旁路面板，
 * 关闭后仍可回到原先钉住的曲目详情。
 */
export function SearchTipsPanel() {
  return (
    <div className="kd-tips-panel">
      <div className="kd-tips-summary">
        <HintBulbIcon size={18} aria-hidden="true" />
        <strong>全部使用提示</strong>
      </div>

      <ul className="kd-tips-list" aria-label={`全部 ${SEARCH_TIPS.length} 条使用提示`}>
        {SEARCH_TIPS.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
    </div>
  );
}
