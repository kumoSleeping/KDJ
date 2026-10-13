import { SEARCH_TIPS } from "./SearchBar";
import { MouseDemo, type MouseDemoScene } from "../common/MouseDemo";
import { SlidePages } from "../drawer/SlidePages";
import { tipsPages, useTipsPage, type TipsPage } from "../../lib/tipsPages";

interface Lesson {
  scene: MouseDemoScene;
  tray?: "download" | "export";
  caption: string;
}

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** What each page teaches: a picture of the little mouse doing it, and one line. */
const LESSONS: Record<Exclude<TipsPage, "all">, Lesson[]> = {
  search: [
    { scene: "search", caption: "输入歌名、歌手或链接，按 Enter 开始搜索~" },
    { scene: "pick-range", caption: "Shift 点两下，中间整段一起选中" },
    { scene: "pick-toggle", caption: `${mod} 点选，一首一首加进来或拿出去` },
  ],
  download: [
    { scene: "drag-in", tray: "download", caption: "把搜索结果拖进下载，就排进队列~" },
    { scene: "drag-in", tray: "export", caption: "把本地歌曲拖进导出，一样轻松" },
  ],
  viz: [{ scene: "viz-tune", caption: "拖动滑块，可视化的画面跟着变" }],
  pip: [{ scene: "pip", caption: "小窗可以拖到喜欢的位置" }],
  player: [{ scene: "player-keys", caption: "自动切歌、歌词、小窗，点一下就亮" }],
};

function Lessons({ page }: { page: Exclude<TipsPage, "all"> }) {
  return <div className="kd-tips-lessons">
    {LESSONS[page].map((lesson, index) => <figure key={index} className="kd-tips-lesson">
      <MouseDemo scene={lesson.scene} tray={lesson.tray} label={lesson.caption} />
      <figcaption>{lesson.caption}</figcaption>
    </figure>)}
  </div>;
}

function AllTips() {
  return <ul className="kd-tips-list" aria-label={`全部 ${SEARCH_TIPS.length} 条使用提示`}>
    {SEARCH_TIPS.map(tip => <li key={tip}>{tip}</li>)}
  </ul>;
}

const pageIds = tipsPages.map(page => page.id);

/**
 * 使用提示：每一页教一类功能，由抽屉标题上的页签切换（搜索、下载、可视化、小窗、播放器），
 * 最后一页是搜索框里轮播文案的完整索引。窄屏没有抽屉标题，所以把各页依次排开。
 *
 * 它只负责展示，不持久化任何打开状态；Workspace 会把它当作临时旁路面板，
 * 关闭后仍可回到原先钉住的曲目详情。
 */
export function SearchTipsPanel({ stacked = false }: { stacked?: boolean }) {
  const page = useTipsPage(state => state.page);
  if (stacked) return <div className="kd-tips-panel">
    {tipsPages.map(item => <section key={item.id} aria-label={item.title ?? item.label}>
      {item.id === "all" ? <AllTips /> : <Lessons page={item.id} />}
    </section>)}
  </div>;
  return <div className="kd-tips-panel">
    <SlidePages page={page} order={pageIds}>
      {page === "all" ? <AllTips /> : <Lessons page={page} />}
    </SlidePages>
  </div>;
}
