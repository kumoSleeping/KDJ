import { create } from "zustand";

/**
 * 播放模式：一首放完之后接什么。
 *
 * - `harmonic` 调性接歌：从和声推荐里挑（这是本软件的招牌，所以是默认值）
 * - `order`    顺序播放：按列表顺序一首接一首，到头绕回开头
 * - `shuffle`  随机播放：范围内随机挑，优先没放过的
 * - `one`      单曲循环：一直放这一首
 *
 * 「范围」（全库 / 当前文件夹）不在这里——它复用 harmonicScope 那个开关。
 * 理由和那边注释里写的是同一条：详情栏的接歌范围、播放条上的范围按钮、
 * 自动续播三处**必须是同一个值**，多立一份状态早晚会各说各话。
 */
export type PlayMode = "harmonic" | "order" | "shuffle" | "one";

const STORAGE_KEY = "kd-play-mode";
/** 单击循环切换的顺序：从招牌模式开始，越往后越"传统播放器"。 */
const CYCLE: PlayMode[] = ["harmonic", "order", "shuffle", "one"];

const isMode = (value: string | null): value is PlayMode =>
  value !== null && (CYCLE as string[]).includes(value);

interface PlayModeState {
  mode: PlayMode;
  setMode(mode: PlayMode): void;
  /** 播放条上那颗按钮：点一下换下一种。 */
  cycleMode(): void;
}

export const usePlayMode = create<PlayModeState>((set, get) => ({
  mode: ((value) => (isMode(value) ? value : "harmonic"))(localStorage.getItem(STORAGE_KEY)),
  setMode(mode) {
    localStorage.setItem(STORAGE_KEY, mode);
    set({ mode });
  },
  cycleMode() {
    get().setMode(CYCLE[(CYCLE.indexOf(get().mode) + 1) % CYCLE.length]);
  },
}));
