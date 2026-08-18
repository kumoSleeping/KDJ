import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_DURATION_MS, useToastStore } from "../../stores/toastStore";

const LEAVE_MS = 180;

/**
 * 全局右下角提示。播放失败、STEM 限制这类瞬时消息走这里，
 * 不再插进播放条把底栏撑出一行。
 */
export function ToastHost() {
  const text = useToastStore((state) => state.text);
  const token = useToastStore((state) => state.token);
  const dismiss = useToastStore((state) => state.dismiss);
  const [shown, setShown] = useState("");
  const shownRef = useRef("");
  shownRef.current = shown;

  useEffect(() => {
    if (text) {
      setShown(text);
      const hide = window.setTimeout(() => dismiss(), TOAST_DURATION_MS);
      return () => window.clearTimeout(hide);
    }
    if (!shownRef.current) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const leave = window.setTimeout(() => setShown(""), reduceMotion ? 0 : LEAVE_MS);
    return () => window.clearTimeout(leave);
  }, [text, token, dismiss]);

  if (!shown) return null;

  return createPortal(
    <div key={token} className="kd-toast" data-leaving={!text || undefined} role="status">
      <span>{shown}</span>
      <button type="button" onClick={dismiss} aria-label="关闭提示">
        ×
      </button>
    </div>,
    document.body,
  );
}
