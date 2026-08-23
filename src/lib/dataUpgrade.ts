import { api } from "./api";

let started = false;

/**
 * WebSocket 连好后再启动：迁移进度才能进入现有活动栏，不会丢在启动早期。
 * React 开发模式会重复挂载 effect，模块级闸门保证一个会话只发一次。
 */
export function startDataUpgrade(): void {
  if (started) return;
  started = true;
  void api.upgradeFolders().catch(() => {
    // 后端尚未就绪时允许下一次重连重试；错误本身由连接状态负责展示。
    started = false;
  });
}
