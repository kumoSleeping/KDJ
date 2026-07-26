import { create } from "zustand";

/**
 * 「搜VJ(Bili)」的候选关键词。
 *
 * 这些词是拿来**拼进 B 站搜索框**的，所以选词标准只有一条：
 * 加上它之后，搜出来的东西是不是更可能是"能当 VJ 素材用的画面"。
 *
 * 默认这十个的来路：
 *   MV / 官方 / PV   —— 原版画面，画质最好，最常用
 *   AMV / MAD        —— 动画剪辑，B 站上这两个 tag 的量最大
 *   手书             —— 手绘动画，画风独特，适合慢歌
 *   现场 / Live      —— 演出实录，接现场感的段落
 *   混剪             —— 多素材剪辑，节奏快
 *   歌词版           —— 纯字幕画面，垫场或者不想抢视觉时用
 *   4K               —— 直接筛画质，投到大屏上差别很明显
 *   循环             —— 可无缝循环的素材，长段落垫底
 */
export const DEFAULT_VJ_KEYWORDS = [
  "MV",
  "官方",
  "PV",
  "AMV",
  "MAD",
  "手书",
  "现场",
  "混剪",
  "歌词版",
  "4K",
  "循环",
];

const KEYWORDS_KEY = "kd-vj-keywords";
const ARTIST_KEY = "kd-vj-with-artist";

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEYWORDS_KEY);
    if (!raw) return DEFAULT_VJ_KEYWORDS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VJ_KEYWORDS;
    // 存过一次空数组也要认：用户可能就是把默认词全删了，
    // 这时候再"贴心地"塞回默认值就是删不掉
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return DEFAULT_VJ_KEYWORDS;
  }
}

interface VjKeywordState {
  keywords: string[];
  /** 拼搜索词时要不要带上艺人名。 */
  withArtist: boolean;
  add(word: string): void;
  remove(word: string): void;
  reset(): void;
  setWithArtist(value: boolean): void;
}

/**
 * 关键词和「带艺人」开关都长期保存。
 *
 * 理由是它们描述的是**这个人怎么找素材**——常年搜手书的和常年搜现场的
 * 是两种用法，每次开软件重来一遍毫无道理。
 */
export const useVjKeywords = create<VjKeywordState>((set, get) => ({
  keywords: load(),
  withArtist: localStorage.getItem(ARTIST_KEY) === "1",

  add(word) {
    const clean = word.trim();
    // 去重不区分大小写：加了 "mv" 又加 "MV" 只会得到两颗一模一样的按钮
    if (!clean || get().keywords.some((k) => k.toLowerCase() === clean.toLowerCase())) return;
    const next = [...get().keywords, clean];
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(next));
    set({ keywords: next });
  },

  remove(word) {
    const next = get().keywords.filter((k) => k !== word);
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(next));
    set({ keywords: next });
  },

  reset() {
    localStorage.removeItem(KEYWORDS_KEY);
    set({ keywords: DEFAULT_VJ_KEYWORDS });
  },

  setWithArtist(value) {
    localStorage.setItem(ARTIST_KEY, value ? "1" : "0");
    set({ withArtist: value });
  },
}));

/**
 * 拼搜索词。
 *
 * 曲名里那些方括号前缀（`[VDJ]` / `[VJ1]`）和圆括号后缀（remix 标注、
 * 上传者水印）在 B 站搜索里全是噪声——它们是我们自己的文件命名习惯，
 * 不是这首歌在 B 站上的名字。带着搜多半零结果，所以先洗掉。
 */
export function buildVjQuery(title: string, artist: string, keyword: string, withArtist: boolean) {
  const clean = title
    .replace(/^\s*[[【(（][^\]】)）]*[\]】)）]\s*/g, "") // 开头的 [VDJ] 这类标记，可能连着好几个
    .replace(/\s*[([（【][^)\]）】]*[)\]）】]\s*$/g, "") // 结尾的 (xxx remix) 这类括注
    .replace(/[_]+/g, " ")
    .trim();
  return [clean || title, withArtist ? artist.trim() : "", keyword]
    .filter(Boolean)
    .join(" ");
}
