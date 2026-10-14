import { chord, PointerDemo, type PointerDemoScene } from "../common/PointerDemo";
import { SlidePages } from "../drawer/SlidePages";
import { tipsPages, useTipsPage, type TipsPage } from "../../lib/tipsPages";

interface Lesson {
  scene: PointerDemoScene;
  tray?: "download" | "export" | "visualize" | "share";
  caption: string;
}

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** What each page teaches: a picture of the little mouse doing it, and one line. */
const LESSONS: Record<TipsPage, Lesson[]> = {
  search: [
    { scene: "search", caption: "输入歌名、歌手或链接，按 Enter 开始搜索~" },
    { scene: "platforms", caption: "拖动平台图标调整优先级，点一下选中或取消；不用的平台可以在设置里关掉" },
    { scene: "kind-switch", caption: "点「单曲」切换歌单、艺术家等类型，搜到后点进去查看相关内容" },
  ],
  sidebar: [
    { scene: "add-folder", caption: "本地：点 + 添加文件夹，歌曲自动入库" },
    { scene: "sidebar-online", caption: "在线：点一个歌单，在右边查看里面的歌" },
  ],
  download: [
    { scene: "login", caption: "大部分平台要先登录账号才能下载：点侧栏平台旁的「登录」" },
    { scene: "pick-range", caption: "Shift 点两下，中间整段一起选中" },
    { scene: "pick-toggle", caption: `${mod} 点选，一首一首加进来或拿出去` },
    { scene: "menu-toss", tray: "download", caption: "右键一首歌，加入下载队列，它会飞进去" },
    { scene: "drag-in", tray: "download", caption: "也可以直接把歌拖进下载队列" },
  ],
  viz: [
    { scene: "viz-export", caption: "在小窗里，右下角有导出，点一下就排进队列" },
    { scene: "viz-tune", caption: "拖动滑块调整参数，画面实时跟着变" },
    { scene: "drag-in", tray: "visualize", caption: "把本地歌曲拖进可视化，就排进导出" },
    { scene: "menu-toss", tray: "visualize", caption: "右键一首歌，导出可视化，同样飞进队列" },
  ],
  player: [
    { scene: "player-keys", caption: "底部是标准播放器；自动切歌、歌词、小窗，点一下就开关" },
    { scene: "pip", caption: "小窗里可以看视频，自由移动、放大缩小；播放歌曲时展示你调好的可视化" },
    { scene: "mini-player", caption: "还能把整个窗口收成迷你播放器，放在桌面角落" },
  ],
  library: [
    { scene: "multi-copy", caption: `多选后 ${chord("C")}，到目标文件夹 ${chord("V")}，就复制进去` },
    { scene: "analyze", caption: "调性和 BPM 会自动分析，不用手动标" },
    { scene: "menu-toss", tray: "share", caption: "右键一首歌就能分享，会附上歌曲信息和小封面" },
  ],
};

function Lessons({ page }: { page: TipsPage }) {
  return <div className="kd-tips-lessons">
    {LESSONS[page].map((lesson, index) => <figure key={`${page}-${index}`} className="kd-tips-lesson">
      <PointerDemo scene={lesson.scene} tray={lesson.tray} label={lesson.caption} />
      <figcaption>{lesson.caption}</figcaption>
    </figure>)}
  </div>;
}

const pageIds = tipsPages.map(page => page.id);

/**
 * 使用提示：每一页教一类功能，由抽屉标题上的页签切换（搜索、下载、可视化、播放器）。
 * 窄屏没有抽屉标题，所以把各页依次排开。
 *
 * 它只负责展示，不持久化任何打开状态；Workspace 会把它当作临时旁路面板，
 * 关闭后仍可回到原先钉住的曲目详情。
 */
export function SearchTipsPanel({ stacked = false }: { stacked?: boolean }) {
  const page = useTipsPage(state => state.page);
  if (stacked) return <div className="kd-tips-panel">
    {tipsPages.map(item => <section key={item.id} aria-label={item.title ?? item.label}>
      <Lessons page={item.id} />
    </section>)}
  </div>;
  return <div className="kd-tips-panel">
    <SlidePages page={page} order={pageIds}>
      <Lessons page={page} />
    </SlidePages>
  </div>;
}
