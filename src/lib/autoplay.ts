/**
 * 自动续播：一首放完，从和声推荐里挑下一首接上。
 *
 * 为什么记"放过哪些"：推荐是按调性和 BPM 算的，同一首歌的最佳接续
 * 往往互相是对方的第一名（A 推 B、B 又推 A），不记的话两首歌能来回放一整晚。
 *
 * 为什么只记一次开机周期：DJ 的曲库是拿来反复听的，跨天还记着"放过了"
 * 只会让第二天打开软件时推荐池莫名其妙地空掉。放在内存里、关掉即忘，
 * 正好对应用户说的"以一次打开软件为周期"。
 */

import { api } from "./api";
import type { HarmonicMatch, Track } from "../types";

/** 本次运行放过的曲目。刷新页面即清空——这是有意的，见文件头。 */
const played = new Set<number>();

export function markPlayed(trackId: number): void {
  played.add(trackId);
}

export function hasPlayed(trackId: number): boolean {
  return played.has(trackId);
}

/** 只在测试和"重置续播"这种显式操作里用。 */
export function clearPlayHistory(): void {
  played.clear();
}

/**
 * 挑下一首。
 *
 * 用和曲目详情栏里同一条推荐接口，所以"自动接的那首"和用户自己看到的
 * 推荐列表是同一套排序——不会出现"它给我接了一首列表里根本没有的歌"。
 *
 * 容差比详情栏默认的 12 收得更紧：手动挑歌时人可以自己判断能不能对上，
 * 自动接必须保守，接出一首对不上拍的比不接更糟。
 */
export async function pickNext(current: Track): Promise<Track | null> {
  let matches: HarmonicMatch[];
  try {
    matches = await api.harmonic(current.id, 8, 40);
  } catch {
    // 推荐拿不到就安静停下：自动续播是锦上添花，不该弹错误打断用户
    return null;
  }

  const fresh = matches.find(
    (match) => match.track.id !== current.id && !played.has(match.track.id),
  );
  return fresh?.track ?? null;
}
