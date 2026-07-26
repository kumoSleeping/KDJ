import type { ReactNode } from "react";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** 传了就用 <label for>，控件自己写同名 id。 */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** 表单一行：标签 + 控件 + 说明。控件本身由调用方写（.kd-input / .kd-select / .kd-check）。 */
export function Field({ label, hint, htmlFor, className, children }: FieldProps) {
  const classes = ["kd-field", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <label className="kd-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint !== undefined && <span className="kd-field-hint">{hint}</span>}
    </div>
  );
}
