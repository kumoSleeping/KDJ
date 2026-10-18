/** 复制给 AI 的提示词。用法、账号和规则都由 `kdj status` 给出，这里只指路。 */
export function createKdjAiPrompt(cliInvocation = "kdj"): string {
  const invocation = cliInvocation.trim() || "kdj";
  return `你可以通过 KDJ CLI 使用用户电脑上的 KDJ。KDJ 是一个音乐和视频工具，能跨平台搜索、下载、管理本地曲库，并分析音乐和视频。

CLI 入口：${invocation}

先运行 \`${invocation} status\`。它会列出全部命令和用法、各平台的登录状态、下载位置和曲库情况，之后按它的说明操作即可。

除了 KDJ，你也可以结合自己手上的网络搜索、浏览器等工具，综合比较、寻找素材，满足用户在找歌、找视频、下载和视频制作上的各种需求。`;
}
