import { useState } from "react";
import { ArrowUpCircle, Check, LoaderCircle } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { useAppStore } from "../../stores/appStore";
import type { UpdateInfo } from "../../types";
import { Button, InlineNotice } from "../common";
// 和账号行共用同一套行排版，见 AccountRow 里 settingRow 的注释
// （`.kd-set-*` 那套右列写死 240px，在详情栏宽度下会把左边的名字压成竖排）
import { settingRow } from "./AccountRow";

/**
 * 「检查更新」一行，长得和上面那几行账号一样。
 *
 * 检查走后端（`/api/update/check` 问 GitHub 的 latest release）而不是让
 * 前端直接 fetch：桌面的 CSP、安卓 WebView 的证书链、浏览器的 CORS
 * 三边规则各不相同，放后端就只有一条路要维护。
 *
 * 装的动作分两种，按壳的能力自动选，不给用户出选择题：
 *   · 桌面 → `bridge.applyUpdate()`：tauri-plugin-updater 下载 + minisign
 *     校验 + 原地替换 + 自重启，全程不用离开软件；
 *   · 安卓 / 浏览器 → 开 Release 页，用户自己下 APK。
 *     安卓没法自替换（要走系统安装器），这是平台限制不是偷懒。
 */
export function UpdateRow() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "apply">("");
  const [notice, setNotice] = useState("");

  const bridge = getBridge();
  const canSelfUpdate = typeof bridge.applyUpdate === "function";
  // 当前版本从 /api/health 拿：启动时本来就拉过一次，不为了显示一行字
  // 再开一条管子，也不用往三份 vite 配置里各塞一个 define
  const current = useAppStore((state) => state.health?.version) ?? "";

  const check = async () => {
    setBusy("check");
    setNotice("");
    try {
      setInfo(await api.checkUpdate());
    } catch (error) {
      setInfo(null);
      setNotice(`检查更新失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const apply = async () => {
    if (!info) return;
    setNotice("");
    if (!canSelfUpdate) {
      // 开下载页就算完成了这次操作，不留 busy 态——外部浏览器打开之后
      // 我们再也收不到任何后续信号，转圈会一直转下去
      await bridge.openExternal?.(info.url);
      return;
    }
    setBusy("apply");
    try {
      // 成功的话进程会被 restart 掉，下面这行永远不会执行到
      await bridge.applyUpdate?.();
    } catch (error) {
      setNotice(`更新失败：${(error as Error).message}`);
      setBusy("");
    }
  };

  return (
    <div style={settingRow.row}>
      <div style={settingRow.text}>
        <span style={settingRow.avatarIcon} aria-hidden="true">
          <ArrowUpCircle size={15} />
        </span>
        <div style={settingRow.body}>
          {/* 「软件更新」四个字曾经被压成竖排：右列吃掉 240px 之后，
              这一格只剩一个字的宽度。现在名字这行明确 nowrap + 省略号 */}
          <div style={settingRow.label}>软件更新</div>
          <div style={settingRow.hint}>
            {info === null
              ? current
                ? `当前 v${current}`
                : "点右边看看有没有新版本"
              : info.newer
                ? `发现新版本 v${info.latest}（当前 v${info.current}）`
                : `已是最新 v${info.current}`}
          </div>
          <InlineNotice text={notice} onDismiss={() => setNotice("")} />
        </div>
      </div>
      <div style={settingRow.control}>
        {info?.newer ? (
          // 有新版本才用红：这是这个面板里唯一一个"值得现在就点"的动作
          <Button size="sm" variant="primary" disabled={busy !== ""} onClick={() => void apply()}>
            {busy === "apply" ? (
              <>
                <LoaderCircle className="kd-spin" size={12} /> 更新中
              </>
            ) : canSelfUpdate ? (
              "下载并重启"
            ) : (
              "去下载页"
            )}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={() => void check()}>
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
