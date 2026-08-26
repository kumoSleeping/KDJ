import type { DownloadTask } from "../types";

/** A YTM GVS URL is disposable. One automatic re-mint is safer than asking the user to retry. */
export function shouldRefreshYtmDownloadAuthorization(task: DownloadTask): boolean {
  return task.kind === "audio"
    && task.platform === "ytm"
    && task.state === "failed"
    && /(?:播放授权|下载流).*(?:过期|失效)|(?:403|Forbidden)/i.test(task.error);
}
