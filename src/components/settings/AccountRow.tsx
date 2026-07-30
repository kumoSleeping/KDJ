import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { useAppStore } from "../../stores/appStore";
import type { Account, AccountState, Platform, QrStateValue } from "../../types";
import { Button, InlineNotice } from "../common";
import { PLATFORM_BRAND, PlatformMark } from "../download/PlatformMark";

const POLL_INTERVAL_MS = 1500;

const SCAN_WITH: Partial<Record<Platform, string>> = {
  wyy: "用网易云音乐 App 扫码",
  qqm: "用 QQ 扫码",
  bilibili: "用哔哩哔哩 App 扫码",
};

const QR_STATE_TEXT: Partial<Record<QrStateValue, string>> = {
  waiting: "等待扫码",
  scanned: "已扫码，请在手机上确认",
  done: "登录成功",
  expired: "二维码已过期",
  refused: "已在手机上取消",
  error: "登录状态异常",
};

const QR_FINAL_STATES = new Set<QrStateValue>(["done", "expired", "refused", "error"]);

const STATE_LABEL: Record<AccountState, string> = {
  valid: "已登录",
  expired: "登录已过期",
  missing: "未登录",
  unknown: "状态未知",
};

/** 只染状态那几个字，不做整块的彩色标签——一个区域已经有一颗红按钮了。 */
const STATE_COLOR: Record<AccountState, string> = {
  valid: "var(--kd-ok)",
  expired: "var(--kd-warn)",
  missing: "var(--kd-warn)",
  unknown: "inherit",
};

/**
 * 账号面板这一行的排版就地写死，不再走 design.css 的 `.kd-set-*`。
 *
 * 那套类是给已经删掉的"整页设置"写的，右列固定 `width: 15rem`(240px)。
 * 可这个面板住在 ~350px 宽的右侧详情栏里，窄屏还会掉进更窄的底部抽屉——
 * 240px 一被右列吃掉，左边只剩 100 来 px，「网易云音乐」直接被压成一列一个字，
 * 右边那 240px 里却只放着一颗 60px 的按钮，白空一大片。
 *
 * 这里的宽度规则反过来：**右边按钮按内容取宽（不伸不缩），左边吃掉剩下的全部**。
 * 这样从 350px 到全屏都成立，也不用为抽屉再写一档断点。
 *
 * 为什么用内联而不是新起一组全局类：用它的只有这个面板的两种行
 * （账号行 / 更新行），进了 design.css 就迟早被别处"顺手复用"，
 * 然后在别的宽度里重演一遍今天这个塌法。UpdateRow 从这里 import 复用。
 */
export const settingRow = {
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    // 老的 1.5rem 间距在 350px 里是纯浪费，够把文字和按钮分开就行
    gap: "0.75rem",
    padding: "0.55rem 0",
    borderBottom: "1px solid var(--kd-line-soft)",
  },
  /** 头像 + 文字块。flex:1 让它去抢剩余宽度，minWidth:0 才允许它缩到比内容还窄 */
  text: {
    flex: "1 1 auto",
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
  },
  /** 两行文字自己也要 minWidth:0，否则省略号不会生效，撑破的是外面那层 */
  body: { flex: "1 1 auto", minWidth: 0 },
  /** 名字这行宁可省略号也绝不换行：一换行整块就往"竖排"的方向塌 */
  label: {
    color: "var(--kd-text)",
    fontSize: "var(--kd-size-sm)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hint: {
    color: "var(--kd-faint)",
    fontSize: "var(--kd-size-xs)",
    lineHeight: 1.4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /* 头像位：常驻占位块，有图才往里塞 <img>。登录前后左边留白一样宽，
     几行平台名不会因为谁有头像而错开。28px 对着两行文字的高度。 */
  avatar: {
    width: 28,
    height: 28,
    flex: "0 0 auto",
    overflow: "hidden",
    background: "var(--kd-panel-inset)",
    border: "1px solid var(--kd-line)",
  },
  /** 同一个位子放图标而不是头像（更新那行）：不描边，免得看着像个空头像框 */
  avatarIcon: {
    width: 28,
    height: 28,
    flex: "0 0 auto",
    display: "grid",
    placeItems: "center",
    color: "var(--kd-muted)",
  },
  /** 按钮列：不伸不缩，宽度完全由按钮自己的文字定 */
  control: { flex: "0 0 auto" },
} satisfies Record<string, CSSProperties>;

const AVATAR_IMG: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
  transition: "opacity 0.15s",
};

/** QQ 音乐账号接口偶尔只返回 musicid，不返回主页头像；前端仍然可以用公开的
 * QQ 头像地址显示头像。这个兜底不携带任何登录 Cookie。 */
function qqAvatarFallback(account: Account): string {
  if (account.platform !== "qqm") return "";
  const musicid =
    account.detail.match(/(?:^|\D)musicid=(\d+)/)?.[1] ||
    account.avatar.match(/(?:uin|dst_uin)=(\d+)/i)?.[1];
  return musicid ? `https://q.qlogo.cn/headimg_dl?dst_uin=${musicid}&spec=100` : "";
}

/** 机器码不该出现在账号说明里：有昵称就显示昵称，会员等级这类可读文案才留。 */
function isMachineIdDetail(detail: string): boolean {
  const text = detail.trim();
  if (!text) return true;
  if (/^musicid\s*=/i.test(text)) return true;
  if (/^UID\s*\d+/i.test(text)) return true;
  if (/^\d+$/.test(text)) return true;
  return false;
}

/**
 * 一个平台一行。
 *
 * 之前每个平台是一张带角标的卡片，登录按钮还是红底实心的——四个平台排下来
 * 整页都是红块。账号在设置里只是"连没连上"这一件事，一行就够了：
 * 左边名字 + 状态，右边一个文字按钮。
 */
export function AccountRow({ account }: { account: Account }) {
  const refreshAccounts = useAppStore((state) => state.refreshAccounts);
  const openSettingsPanel = useAppStore((state) => state.openSettingsPanel);
  const [busy, setBusy] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [savedPath, setSavedPath] = useState("");
  const [savedHint, setSavedHint] = useState("");
  const [qrState, setQrState] = useState<QrStateValue | null>(null);
  const qrGenerationRef = useRef(0);
  /** 退出失败就贴在这一行自己底下：状态还写着"已登录"，得说清楚为什么。 */
  const [notice, setNotice] = useState("");

  const loggedIn = account.state === "valid";
  const avatarFallback = qqAvatarFallback(account);
  const avatarSrc = account.avatar || avatarFallback;

  useEffect(
    () => () => {
      // 关闭设置会卸载账号行：让仍在等待的轮询自然失效。重新打开后按钮恢复原状。
      qrGenerationRef.current += 1;
    },
    [],
  );

  const saveLoginQr = async () => {
    const generation = ++qrGenerationRef.current;
    setQrBusy(true);
    setSavedPath("");
    setSavedHint("");
    setQrState(null);
    setNotice("");
    try {
      const session = await api.loginQr(account.platform);
      if (generation !== qrGenerationRef.current) return;
      const bridge = getBridge();
      const saved = await bridge.saveLoginQr({
        platform: account.platform,
        label: account.label,
        image: session.image,
      });
      if (generation !== qrGenerationRef.current) return;
      setSavedPath(saved.path);
      setSavedHint(saved.location === "pictures" ? "已保存到相册/图片" : "已保存到下载文件夹");
      setQrState("waiting");
      setQrBusy(false);
      // 保存完成就直接在文件管理器中定位；账号行本身继续留在设置里等待扫码。
      if (!["android", "ios", "browser"].includes(String(bridge.platform))) {
        void bridge
          .revealPath(saved.path)
          .catch(() => bridge.openPath(saved.path))
          .finally(() => openSettingsPanel());
      }

      const poll = async () => {
        if (generation !== qrGenerationRef.current) return;
        try {
          const state = await api.loginQrState(account.platform, session.session_id);
          if (generation !== qrGenerationRef.current) return;
          setQrState(state.state);
          if (state.state === "done") {
            await refreshAccounts();
            return;
          }
          if (QR_FINAL_STATES.has(state.state)) return;
          window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        } catch (error) {
          if (generation === qrGenerationRef.current) {
            setNotice(`登录状态检查失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (error) {
      if (generation !== qrGenerationRef.current) return;
      setQrBusy(false);
      setNotice(`保存登录二维码失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openSavedQr = () => {
    if (!savedPath) return;
    const bridge = getBridge();
    void bridge
      .revealPath(savedPath)
      .catch(() => bridge.openPath(savedPath))
      .catch((error: unknown) => {
        setNotice(`打开保存位置失败：${error instanceof Error ? error.message : String(error)}`);
      })
      // Finder 抢到前台后仍保持设置旁栏为打开态；回来时文件夹按钮也不会复原。
      .finally(() => openSettingsPanel());
  };

  const logout = async () => {
    setBusy(true);
    setNotice("");
    try {
      await api.logout(account.platform);
      // 成功不用报：这一行的状态当场从"已登录"变成"未登录"，按钮也换成保存登录二维码
      await refreshAccounts();
    } catch (error) {
      setNotice(`退出失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={settingRow.row}>
      <div style={settingRow.text}>
        <span
          className="kd-account-avatar"
          style={{
            ...settingRow.avatar,
            display: "grid",
            placeItems: "center",
            color: PLATFORM_BRAND[account.platform] ?? "var(--kd-muted)",
          }}
          aria-hidden="true"
        >
          {avatarSrc && (
            <img
              src={avatarSrc}
              alt=""
              style={AVATAR_IMG}
              referrerPolicy="no-referrer"
              onError={(event) => {
                // 后端返回的主页头像失效时切到 musicid 兜底；兜底本身也失败才隐藏。
                if (avatarFallback && event.currentTarget.src !== avatarFallback) {
                  event.currentTarget.src = avatarFallback;
                  return;
                }
                event.currentTarget.style.opacity = "0";
              }}
            />
          )}
          {!avatarSrc && !loggedIn && <PlatformMark id={account.platform} size={17} />}
        </span>
        <div style={settingRow.body}>
          {/* title 兜住省略号：名字被截了还能悬停看全 */}
          <div style={settingRow.label} title={account.label}>
            {account.label}
          </div>
          <div style={settingRow.hint}>
            {/* 状态本身就是这行的说明，不再另起一个彩色标签 */}
            <span style={{ color: STATE_COLOR[account.state] }}>{STATE_LABEL[account.state]}</span>
            {account.nickname && ` · ${account.nickname}`}
            {/* detail 常常就是状态本身（"未登录"），或 UID/musicid 这类机器码——都不展示 */}
            {account.detail &&
              account.detail !== STATE_LABEL[account.state] &&
              !isMachineIdDetail(account.detail) &&
              ` · ${account.detail}`}
          </div>
          {savedPath && !loggedIn && (
            <div style={settingRow.hint} title={savedPath}>
              {savedHint}
              {" · "}
              {qrState === "waiting"
                ? (SCAN_WITH[account.platform] ?? "等待扫码")
                : (qrState && QR_STATE_TEXT[qrState]) || "等待扫码"}
            </div>
          )}
          {/* 贴在状态行下面，而不是塞进右边那一列：那一列只有按钮那么宽，
              一句"退出失败：连接被拒绝"进去就只剩省略号了 */}
          <InlineNotice text={notice} onDismiss={() => setNotice("")} />
        </div>
      </div>
      <div style={settingRow.control}>
        {!account.supports_login ? (
          // 不支持登录的平台（SoundCloud）连按钮都不给，点了只会撞上后端的 RuntimeError
          <span className="kd-faint" style={{ fontSize: "var(--kd-size-xs)" }}>
            无需登录
          </span>
        ) : loggedIn ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void logout()}>
            退出
          </Button>
        ) : savedPath ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label="在文件夹中显示登录二维码"
            title={savedPath}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openSavedQr();
            }}
          >
            <FolderOpen size={14} />
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={qrBusy} onClick={() => void saveLoginQr()}>
            {qrBusy && <LoaderCircle size={13} className="kd-spin" />}
            {qrBusy ? "正在保存" : "保存登录二维码"}
          </Button>
        )}
      </div>
    </div>
  );
}
