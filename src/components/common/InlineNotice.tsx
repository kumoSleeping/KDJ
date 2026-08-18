import { X } from "lucide-react";
import { Button } from "./Button";

export interface InlineNoticeProps {
  /** 空串 = 什么都不渲染，调用点不用自己写 `{error && ...}`。 */
  text: string;
  /** 给了就出现一个关掉的叉；不给就只能靠下一次操作把它冲掉。 */
  onDismiss?: () => void;
  /** 独占一行时（面板底部、按钮下面）自己撑开一点内边距。 */
  block?: boolean;
  className?: string;
}

/**
 * 操作失败后的就地提示。
 *
 * 面板里、按钮旁边的失败回执贴在出事的地方，不会自己消失。
 * 播放 / STEM 这类瞬时消息走右下角 ToastHost，10 秒后弹回。
 *
 * 用 warn 芯片而不是红字：红色在这个界面里只给"动作"，
 * 一个区域再多一块红，真正要被按的那个按钮就不显眼了。
 */
export function InlineNotice({ text, onDismiss, block, className }: InlineNoticeProps) {
  if (!text) return null;
  const classes = ["kd-notice", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-block={block || undefined} role="status">
      <span className="kd-chip" data-tone="warn">
        出错
      </span>
      <span className="kd-notice-text kd-muted" title={text}>
        {text}
      </span>
      {onDismiss && (
        <Button variant="ghost" size="sm" iconOnly aria-label="关闭提示" onClick={onDismiss}>
          <X size={11} />
        </Button>
      )}
    </div>
  );
}
