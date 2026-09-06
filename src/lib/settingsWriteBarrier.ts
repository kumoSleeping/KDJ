/**
 * 设置写入与依赖设置的后续动作共用的顺序屏障。
 *
 * 界面可以先乐观展示新值，但下载入队必须等此前的设置请求真正落盘；否则用户刚选的
 * 下载目录还没到后端，第一条任务会冻结旧目录，第二条才看起来正常。
 */
export interface SettingsWriteBarrier {
  enqueue<T>(write: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

export function createSettingsWriteBarrier(): SettingsWriteBarrier {
  // queueTail 只负责让后一次写入能在前一次失败后继续；latestWrite 则保留最后一次
  // 写入的真实结果，让依赖设置的动作在保存失败时停下，绝不能拿旧设置继续执行。
  let queueTail: Promise<void> = Promise.resolve();
  let latestWrite: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(write: () => Promise<T>): Promise<T> {
      const queued = queueTail.then(write, write);
      latestWrite = queued.then(() => undefined);
      // 排队通道本身永远恢复为 fulfilled；单次调用和下载屏障仍保留真实错误。
      queueTail = latestWrite.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },

    wait(): Promise<void> {
      // 只等待调用这一刻之前已经排进来的设置意图；之后的新改动不应倒插到下载前面。
      return latestWrite;
    },
  };
}

const settingsWrites = createSettingsWriteBarrier();

export const enqueueSettingsWrite = <T>(write: () => Promise<T>): Promise<T> =>
  settingsWrites.enqueue(write);

export const waitForSettingsWrites = (): Promise<void> => settingsWrites.wait();
