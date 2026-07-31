import { create } from "zustand";

/**
 * Explore「搜索 VJ」的候选关键词。
 *
 * 这些词是拿来**拼进 B 站搜索框**的，所以选词标准只有一条：
 * 加上它之后，搜出来的东西是不是更可能是"能当 VJ 素材用的画面"。
 *
 * 默认列表来自实际常用配置：
 *   MV / 官方 / PV   —— 原版画面
 *   MAD / 手书       —— 二次创作与手绘
 *   现场             —— 演出实录
 *   4K               —— 画质
 *   ニコカラ         —— 卡拉 OK / 歌词向素材
 *   投屏             —— 可投屏用的画面
 */
export const DEFAULT_VJ_KEYWORDS = [
  "MV",
  "官方",
  "PV",
  "MAD",
  "手书",
  "现场",
  "4K",
  "ニコカラ",
  "投屏",
];

/** 新装 / 重置后默认勾上的词。 */
export const DEFAULT_VJ_PICKED = ["MV", "4K", "ニコカラ"];

const KEYWORDS_KEY = "kd-vj-keywords";
const ARTIST_KEY = "kd-vj-with-artist";
const PICKED_KEY = "kd-vj-picked";

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
  /** 勾中的那几个。可以一个都不勾——那就是拿曲名裸搜。 */
  picked: string[];
  /** 拼搜索词时要不要带上艺人名。 */
  withArtist: boolean;
  add(word: string): void;
  remove(word: string): void;
  reset(): void;
  toggle(word: string): void;
  setWithArtist(value: boolean): void;
}

function loadPicked(): string[] {
  try {
    const raw = localStorage.getItem(PICKED_KEY);
    if (raw === null) return DEFAULT_VJ_PICKED;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : DEFAULT_VJ_PICKED;
  } catch {
    return DEFAULT_VJ_PICKED;
  }
}

/**
 * 关键词和「带艺人」开关都长期保存。
 *
 * 理由是它们描述的是**这个人怎么找素材**——常年搜手书的和常年搜现场的
 * 是两种用法，每次开软件重来一遍毫无道理。
 */
export const useVjKeywords = create<VjKeywordState>((set, get) => ({
  keywords: load(),
  picked: loadPicked(),
  // 未写过开关时默认带上艺人（和旧版「永远带艺人」一致）；显式存 "0" 才关掉。
  withArtist: localStorage.getItem(ARTIST_KEY) !== "0",

  toggle(word) {
    const picked = get().picked;
    const next = picked.includes(word)
      ? picked.filter((k) => k !== word)
      : [...picked, word];
    localStorage.setItem(PICKED_KEY, JSON.stringify(next));
    set({ picked: next });
  },

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
    // 勾选里也要摘掉：留着的话它会继续参与拼词，而界面上已经看不见这个词了
    const picked = get().picked.filter((k) => k !== word);
    localStorage.setItem(PICKED_KEY, JSON.stringify(picked));
    set({ keywords: next, picked });
  },

  reset() {
    localStorage.removeItem(KEYWORDS_KEY);
    localStorage.removeItem(PICKED_KEY);
    set({ keywords: DEFAULT_VJ_KEYWORDS, picked: DEFAULT_VJ_PICKED });
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
export function buildVjQuery(
  title: string,
  artist: string,
  keywords: string[],
  withArtist: boolean,
) {
  const clean = title
    .replace(/^\s*[[【(（][^\]】)）]*[\]】)）]\s*/g, "") // 开头的 [VDJ] 这类标记，可能连着好几个
    .replace(/\s*[([（【][^)\]）】]*[)\]）】]\s*$/g, "") // 结尾的 (xxx remix) 这类括注
    .replace(/[_]+/g, " ")
    .trim();
  return [clean || title, withArtist ? artist.trim() : "", ...keywords]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}
