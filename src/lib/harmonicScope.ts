import { create } from "zustand";

/**
 * 接歌的候选范围。
 *
 * 默认 `all`——曲库就是拿来全局接的，一上来限死在当前文件夹里会让人
 * 以为"库里没歌能接"。`folder` 是给按包准备 set 的场景：那时候要的
 * 恰恰是"只在这个文件夹里挑"。
 */
export type HarmonicScope = "all" | "folder";

const STORAGE_KEY = "kd-harmonic-scope";

const isScope = (value: string | null): value is HarmonicScope =>
  value === "all" || value === "folder";

interface HarmonicScopeState {
  scope: HarmonicScope;
  setScope(scope: HarmonicScope): void;
}

/**
 * 单独一个小 store，而不是塞进 libraryStore。
 *
 * 它同时被两个互不相识的地方读：详情栏的「接下一首」列表，和一首放完之后
 * 自动续播的 `pickNext`。**两边必须是同一个值**——用户把范围收到当前文件夹，
 * 结果自动续播还是从全库里接，那就是这个开关最难被发现的失效方式。
 *
 * 跨会话记住：范围是"我现在怎么用这个软件"（排 set / 随便听），
 * 不是一次性的临时筛选，每次开软件都要重设一遍很烦。
 */
export const useHarmonicScope = create<HarmonicScopeState>((set) => ({
  scope: ((value) => (isScope(value) ? value : "all"))(localStorage.getItem(STORAGE_KEY)),
  setScope(scope) {
    localStorage.setItem(STORAGE_KEY, scope);
    set({ scope });
  },
}));
