import { ArrowUpCircle, Check, LoaderCircle } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { useAppStore } from "../../stores/appStore";
import { useUpdateStore } from "../../stores/updateStore";
import { Button, InlineNotice } from "../common";
import { settingRow } from "./AccountRow";

/**
 * 软件更新行：检查走 updateStore（与顶栏待下载、静默轮询共用状态）。
 * 手动检查失败才报错；下载/安装失败也报。
 */
export function UpdateRow() {
  const info = useUpdateStore((s) => s.info);
  const checking = useUpdateStore((s) => s.checking);
  const applying = useUpdateStore((s) => s.applying);
  const notice = useUpdateStore((s) => s.manualError);
  const progress = useUpdateStore((s) => s.progress);
  const check = useUpdateStore((s) => s.check);
  const apply = useUpdateStore((s) => s.apply);
  const clearManualError = useUpdateStore((s) => s.clearManualError);

  const bridge = getBridge();
  const canSelfUpdate = typeof bridge.applyUpdate === "function";
  const isAndroid = bridge.platform === "android";
  const current = useAppStore((state) => state.health?.version) ?? "";
  const busy = checking ? "check" : applying ? "apply" : "";

  const progressLabel = (() => {
    if (busy !== "apply" || !progress) return "";
    if (progress.stage === "downloading") {
      if (progress.total && progress.total > 0) {
        return `下载中 ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`;
      }
      return "下载中";
    }
    if (progress.stage === "installing") return "正在安装";
    if (progress.stage === "restarting") return "正在重启";
    return "准备更新";
  })();

  return (
    <div style={settingRow.row}>
      <div style={settingRow.text}>
        <span style={settingRow.avatarIcon} aria-hidden="true">
          <ArrowUpCircle size={15} />
        </span>
        <div style={settingRow.body}>
          <div style={settingRow.label}>软件更新</div>
          <div style={settingRow.hint}>
            {progressLabel ||
              (info === null
                ? current
                  ? `当前 v${current}`
                  : "点右边看看有没有新版本"
                : info.newer
                  ? `发现新版本 v${info.latest}（当前 v${info.current}）`
                  : `已是最新 v${info.current}`)}
          </div>
          <InlineNotice text={notice} onDismiss={clearManualError} />
        </div>
      </div>
      <div style={settingRow.control}>
        {info?.newer ? (
          <Button size="sm" variant="primary" disabled={busy !== ""} onClick={() => void apply()}>
            {busy === "apply" ? (
              <>
                <LoaderCircle className="kd-spin" size={12} /> 更新中
              </>
            ) : canSelfUpdate ? (
              "下载并重启"
            ) : isAndroid ? (
              "下载 APK"
            ) : (
              "去下载页"
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== ""}
            onClick={() => void check({ silent: false })}
          >
            {busy === "check" ? (
              <>
                <LoaderCircle className="kd-spin" size={12} /> 检查中
              </>
            ) : info ? (
              <>
                <Check size={12} /> 重新检查
              </>
            ) : (
              "检查更新"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
