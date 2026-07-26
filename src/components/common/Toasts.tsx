import { useAppStore } from "../../stores/appStore";

/** 右下角浮层。5 秒自动消失（appStore 里定时），点一下也能立刻关掉。 */
export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="kd-toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="kd-toast"
          data-level={toast.level}
          role="status"
          onClick={() => dismiss(toast.id)}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
