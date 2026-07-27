import { create } from "zustand";

/**
 * 协同播放 + 交叉推子的共享状态。
 *
 * 唱盘（底部播放条）和视频预览平时靠 audioFocus 互斥出声；打开协同播放后
 * 两边同时出声，音量由这把推子分配——推到最左只剩唱盘，最右只剩预览，
 * 中间是混合地带。放 store 而不是发事件：推子是**连续量**，拖动时每帧都在变，
 * 事件那套「喊一嗓子」的语义装不下它；而且 PlayerBar 和 VideoPreview
 * 互不相识，得有个两边都能看的地方。
 */
interface CrossfadeState {
  /** 协同播放开没开。开着时 audioFocus 的互斥对「唱盘 ↔ 预览」这一对失效。 */
  coplay: boolean;
  /** 推子位置 0..1：0 = 全唱盘（左），1 = 全预览（右），0.5 = 中点。 */
  x: number;
  /**
   * 「对齐重启」的信号量：每次拨开协同 +1。协同播放的约定是**两边同时
   * 从头来**——唱盘归零起播，预览按 Offset 对位——否则两条时间线的相对
   * 位置全看拨开关那一刻的手气，校出来的 Offset 毫无意义。
   * PlayerBar 看它变了就把唱盘倒回 0 起播；0 = 这个会话里还没开过协同。
   */
  epoch: number;
  /** 开协同：置位 + epoch+1，两边各自听信号做「从头对齐」。 */
  engage(): void;
  setCoplay(on: boolean): void;
  setX(x: number): void;
}

export const useCrossfade = create<CrossfadeState>((set) => ({
  coplay: false,
  x: 0.5,
  epoch: 0,
  engage: () => set((state) => ({ coplay: true, epoch: state.epoch + 1 })),
  setCoplay: (coplay) => set({ coplay }),
  setX: (x) => set({ x: Math.min(1, Math.max(0, x)) }),
}));

/**
 * 等功率曲线（经典 DJ 混音曲线）：两路增益取 cos/sin，任意推子位置上
 * 功率和恒为 1。线性淡入淡出在中点会塌下去 3dB，听感是「中间那段瘪了」。
 * 协同没开时两边都回满音量——推子只在混的时候管事。
 */
export const deckGain = (coplay: boolean, x: number): number =>
  coplay ? Math.cos((x * Math.PI) / 2) : 1;

export const previewGain = (coplay: boolean, x: number): number =>
  coplay ? Math.sin((x * Math.PI) / 2) : 1;
