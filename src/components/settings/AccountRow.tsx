import { useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";
import type { Account, AccountState } from "../../types";
import { Button, InlineNotice } from "../common";
import { QrLoginDialog } from "./QrLoginDialog";

const STATE_LABEL: Record<AccountState, string> = {
  valid: "已登录",
  expired: "登录已过期",
  missing: "未登录",
  unknown: "状态未知",
};

/**
 * 一个平台一行。
 *
 * 之前每个平台是一张带角标的卡片，登录按钮还是红底实心的——四个平台排下来
 * 整页都是红块。账号在设置里只是"连没连上"这一件事，一行就够了：
 * 左边名字 + 状态，右边一个文字按钮。
 */
export function AccountRow({ account }: { account: Account }) {
  const refreshAccounts = useAppStore((state) => state.refreshAccounts);
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 退出失败就贴在这一行自己底下：状态还写着"已登录"，得说清楚为什么。 */
  const [notice, setNotice] = useState("");

  const loggedIn = account.state === "valid";

  const logout = async () => {
    setBusy(true);
    setNotice("");
    try {
      await api.logout(account.platform);
      // 成功不用报：这一行的状态当场从"已登录"变成"未登录"，按钮也换成扫码登录
      await refreshAccounts();
    } catch (error) {
      setNotice(`退出失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kd-set-row">
      <div className="kd-set-text kd-row" style={{ gap: "0.55rem" }}>
        {account.avatar && (
          <img
            className="kd-set-avatar"
            src={account.avatar}
            alt=""
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <div className="kd-set-label">{account.label}</div>
          <div className="kd-set-hint kd-truncate">
            {/* 状态本身就是这行的说明，不再另起一个彩色标签 */}
            <span data-state={account.state}>{STATE_LABEL[account.state]}</span>
            {account.nickname && ` · ${account.nickname}`}
            {/* detail 常常就是状态本身（"未登录"），重复一遍纯属噪音 */}
            {account.detail && account.detail !== STATE_LABEL[account.state] && ` · ${account.detail}`}
          </div>
          {/* 贴在状态行下面，而不是塞进右边那一列：那一列只有按钮那么宽，
              一句"退出失败：连接被拒绝"进去就只剩省略号了 */}
          <InlineNotice text={notice} onDismiss={() => setNotice("")} />
        </div>
      </div>
      <div className="kd-set-control" style={{ textAlign: "right" }}>
        {!account.supports_login ? (
          // 不支持登录的平台（SoundCloud）连按钮都不给，点了只会撞上后端的 RuntimeError
          <span className="kd-faint">无需登录</span>
        ) : loggedIn ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void logout()}>
            退出
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setShowQr(true)}>
            扫码登录
          </Button>
        )}
      </div>

      {showQr && (
        <QrLoginDialog
          platform={account.platform}
          label={account.label}
          onClose={() => setShowQr(false)}
          onSuccess={() => void refreshAccounts()}
        />
      )}
    </div>
  );
}
