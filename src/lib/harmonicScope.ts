import { create } from "zustand";

/**
 * 接歌的候选范围。
 *
 * 默认 `all`——曲库就是拿来全局接的，一上来限死在当前文件夹里会让人
 * 以为"库里没歌能接"。`folder` 是给按包准备 set 的场景：那时候要的
 * 恰恰是"只在这个歌单里挑"。`queue` 只放临时列表（点歌队列）里的歌，
 * 放空了就停——KTV 的"唱完已点就散场"。
 * （队列非空时本来就**任何范围都优先放队列**，见 autoplay.pickNext；
 * 这一档额外买到的只是"队列空了不要自己找歌"。）
 */
export type HarmonicScope = "all" | "folder" | "queue";

const STORAGE_KEY = "kd-harmonic-scope";

const isScope = (value: string | null): value is HarmonicScope =>
  value === "all" || value === "folder" || value === "queue";

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
