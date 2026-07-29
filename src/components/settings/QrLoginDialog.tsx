import { useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api } from "../../lib/api";
import type { Platform, QrState, QrStateValue } from "../../types";
import { Button } from "../common";

const POLL_INTERVAL_MS = 1500;

/** 登录成功后停留多久再自己关掉。够看清昵称，又不用再点一下「完成」。 */
const CLOSE_DELAY_MS = 900;

/**
 * 扫的是哪个 App。
 *
 * QQ 音乐的二维码要用 **QQ** 扫，不是 QQ 音乐——弹窗上只写「QQ 音乐」的话，
 * 人会打开 QQ 音乐 App 找扫码入口，找不到。这句话省掉的是一次真实的困惑。
 */
const SCAN_WITH: Partial<Record<Platform, string>> = {
  wyy: "用网易云音乐 App 扫码",
  qqm: "用 QQ 扫码（不是 QQ 音乐）",
  bilibili: "用哔哩哔哩 App 扫码",
};

const STATE_TEXT: Record<QrStateValue, string> = {
  waiting: "等待扫码",
  scanned: "已扫码，请在手机上确认",
  done: "登录成功",
  expired: "二维码已过期",
  refused: "已在手机上取消",
  error: "出错了",
};

/** 终态：不再轮询。 */
const FINAL_STATES = new Set<QrStateValue>(["done", "expired", "refused", "error"]);

export interface QrLoginDialogProps {
  platform: Platform;
  label: string;
  onClose(): void;
  onSuccess(): void;
}

export function QrLoginDialog({ platform, label, onClose, onSuccess }: QrLoginDialogProps) {
  const [image, setImage] = useState("");
  const [status, setStatus] = useState<QrState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);
  // 卸载后仍在飞的请求不能再 setState，也不能再排下一次轮询
  const aliveRef = useRef(true);

  /**
   * 回调放进 ref，**不进** effect 依赖。
   *
   * 这是「扫完码又冒出一张新二维码」的真凶：调用方传的是内联箭头函数
   * （`onSuccess={() => void refreshAccounts()}`），每次渲染都是新身份；
   * 而登录成功 → refreshAccounts → 父组件重渲染 → onSuccess 换身份
   * → 下面那个 effect 判定依赖变了 → 重跑 → **重新申请一张二维码**。
   * 明明已经登录成功，弹窗却像什么都没发生一样刷新了。
   */
  const successRef = useRef(onSuccess);
  const closeRef = useRef(onClose);
  successRef.current = onSuccess;
  closeRef.current = onClose;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sessionId = "";
    setLoading(true);
    setImage("");
    setStatus(null);
    setError("");

    const poll = async () => {
      try {
        const state = await api.loginQrState(platform, sessionId);
        if (!aliveRef.current) return;
        setStatus(state);
        if (state.state === "done") {
          successRef.current();
          // 成功之后自己关掉：右边那一行当场就变成「已登录」，
          // 还要用户再点一下「完成」纯属多一步。留 0.9s 让人看清昵称。
          timer = setTimeout(() => {
            if (aliveRef.current) closeRef.current();
          }, CLOSE_DELAY_MS);
          return;
        }
        if (FINAL_STATES.has(state.state)) return;
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (reason) {
        if (!aliveRef.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    };

    api
      .loginQr(platform)
      .then((session) => {
        if (!aliveRef.current) return;
        sessionId = session.session_id;
        setImage(session.image);
        setLoading(false);
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      })
      .catch((reason: unknown) => {
        if (!aliveRef.current) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      if (timer) clearTimeout(timer);
    };
    // onSuccess/onClose 有意不进依赖，走 ref——理由见上面 successRef 的注释
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, round]);

  const done = status?.state === "done";
  const stale = status !== null && FINAL_STATES.has(status.state) && !done;

  return (
    <div className="kd-overlay kd-pop-scrim" role="dialog" aria-modal="true" aria-label={`${label}扫码登录`}>
      <div className="kd-dialog kd-pop-panel">
        {/* 原来这里挂着一枚红色的「登录」角标。删掉的理由：弹窗标题已经写着
            平台名、内容是一张二维码，角标既不提供信息又占掉了这块唯一的红色额度。 */}
        <div className="kd-dialog-head">
          {label}
          <span className="kd-toolbar-gap" />
          <Button variant="ghost" size="sm" iconOnly aria-label="关闭" onClick={onClose}>
            <X size={13} />
          </Button>
        </div>

        <div className="kd-dialog-body kd-col" style={{ alignItems: "center", gap: "0.8rem" }}>
          {loading ? (
            <div className="kd-row kd-muted" style={{ height: 220 }}>
              <LoaderCircle className="kd-spin" size={20} /> 正在获取二维码
            </div>
          ) : error ? (
            <p style={{ color: "var(--kd-danger)", textAlign: "center" }}>{error}</p>
          ) : done ? (
            <div className="kd-col" style={{ alignItems: "center", gap: "0.5rem", height: 220, justifyContent: "center" }}>
              <CheckCircle2 size={40} color="var(--kd-ok)" />
              <strong>{status?.account?.nickname || "登录成功"}</strong>
            </div>
          ) : (
            <>
              <img
                src={image}
                alt="登录二维码"
                width={220}
                height={220}
                // 过期/取消后二维码已失效，压暗提示要点重试
                style={{ opacity: stale ? 0.25 : 1, imageRendering: "pixelated", background: "#fff" }}
              />
              {/* 「用哪个 App 扫」比「等待扫码」有用得多——尤其 QQ 音乐是用 QQ 扫的 */}
              <div className="kd-row kd-muted" style={{ gap: "0.4rem" }}>
                {status?.state === "scanned" && <LoaderCircle className="kd-spin" size={13} />}
                <span>
                  {status && status.state !== "waiting"
                    ? STATE_TEXT[status.state]
                    : (SCAN_WITH[platform] ?? "等待扫码")}
                </span>
              </div>
              {/* 后端的 message 常常就是状态本身（"等待扫码"），原样再印一遍
                  就成了屏幕上同一句话出现两次。只在它真的多说了点什么时才显示。 */}
              {status?.message && status.message !== STATE_TEXT[status.state] && (
                <p className="kd-faint">{status.message}</p>
              )}
            </>
          )}
        </div>

        <div className="kd-dialog-foot">
          {(stale || error !== "") && (
            <Button onClick={() => setRound((value) => value + 1)}>
              <RefreshCw size={13} />
              换一张
            </Button>
          )}
          <Button variant={done ? "primary" : "ghost"} onClick={onClose}>
            {done ? "完成" : "取消"}
          </Button>
        </div>
      </div>
    </div>
  );
}
