import { useState } from "react";
import { X } from "lucide-react";
import { reportError, useReportEntry } from "../../lib/errorReport";
import { Button } from "./Button";

export interface InlineNoticeProps {
  /** 空串 = 什么都不渲染，调用点不用自己写 `{error && ...}`。 */
  text: string;
  /** 给了就出现一个关掉的叉；不给就只能靠下一次操作把它冲掉。 */
  onDismiss?: () => void;
  /** 独占一行时（面板底部、按钮下面）自己撑开一点内边距。 */
  block?: boolean;
  className?: string;
  /** 默认 warn/出错；成功回执用 ok。 */
  tone?: "warn" | "ok";
  chip?: string;
  /** 出错的提示默认带「上报」；上报处自己的失败回执不带，免得绕回自己。 */
  report?: boolean;
  /** 一开始就整段换行显示（上报失败的原因就在末尾的括号里，截掉就什么也看不出）。 */
  wrap?: boolean;
}

/**
 * 操作失败后的就地提示。
 *
 * 面板里、按钮旁边的失败回执贴在出事的地方，不会自己消失。
 * 播放失败这类瞬时消息是一条任务信息（docs/task-bubbles.md），停留一会儿后自己收起。
 *
 * 用 warn 芯片而不是红字：红色在这个界面里只给"动作"，
 * 一个区域再多一块红，真正要被按的那个按钮就不显眼了。
 *
 * It arrives with the schema's `pop` (docs/motion-schema.md). It lies in the flow, so it has
 * no leaving gesture: the space it held closes at once.
 *
 * 出错的提示都带一个「上报」键，直达设置里给开发者的上报处（`reportError`）；没有设置抽屉的
 * 窗口里不出现。提示默认占一行、放不下就截断；允许换行的地方（账号、混音操作），它是
 * 一段正常的文字：「出错」打头，字按整宽换行，键跟在最后一个字后面，谁也不单占一栏。
 * 截断的提示点一下字就这样展开成全文，再点收回；字可以长按选中、复制（手机上没有悬停提示）。
 */
export function InlineNotice({
  text,
  onDismiss,
  block,
  className,
  tone = "warn",
  chip,
  report = true,
  wrap = false,
}: InlineNoticeProps) {
  const canReport = useReportEntry(state => state.ready) && tone === "warn" && report;
  // The text that was opened: another notice in the same place starts on one line again.
  const [opened, setOpened] = useState<string | null>(null);
  if (!text) return null;
  const open = wrap || opened === text;
  const classes = ["kd-notice", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-block={block || undefined} data-wrap={open || undefined} data-kd-motion="pop" role="status">
      <span className="kd-chip" data-tone={tone}>
        {chip ?? (tone === "ok" ? "完成" : "出错")}
      </span>
      <span className="kd-notice-text kd-muted" title={text}
        onClick={wrap ? undefined : () => {
          // A long press that selected the words is a copy, not a tap.
          if (!window.getSelection()?.isCollapsed) return;
          setOpened(open ? null : text);
        }}>
        {text}
      </span>
      {canReport && (
        <Button variant="ghost" size="sm" className="kd-notice-report" title="上报给开发者" onClick={() => reportError(text)}>
          上报
        </Button>
      )}
      {onDismiss && (
        <Button variant="ghost" size="sm" iconOnly aria-label="关闭提示" onClick={onDismiss}>
          <X size={11} />
        </Button>
      )}
    </div>
  );
}
