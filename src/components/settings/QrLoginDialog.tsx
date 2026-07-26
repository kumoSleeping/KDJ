import { useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api } from "../../lib/api";
import type { Platform, QrState, QrStateValue } from "../../types";
import { Button, CornerBadge } from "../common";

const POLL_INTERVAL_MS = 1500;

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
          onSuccess();
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
  }, [platform, round, onSuccess]);

  const done = status?.state === "done";
  const stale = status !== null && FINAL_STATES.has(status.state) && !done;

  return (
    <div className="kd-overlay" role="dialog" aria-modal="true" aria-label={`${label}扫码登录`}>
      <div className="kd-dialog">
        <CornerBadge>登录</CornerBadge>
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
              <div className="kd-row kd-muted" style={{ gap: "0.4rem" }}>
                {status?.state === "scanned" && <LoaderCircle className="kd-spin" size={13} />}
                <span>{status ? STATE_TEXT[status.state] : "等待扫码"}</span>
              </div>
              {status?.message && <p className="kd-faint">{status.message}</p>}
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
