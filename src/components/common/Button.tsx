import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 只放一个图标时用，宽度锁成正方形。 */
  iconOnly?: boolean;
}

/**
 * .kd-btn 的薄封装。default/md 不写 data-* ——
 * design.css 里它们就是基础样式，多写属性只会让 DOM 更吵。
 */
export function Button({
  variant = "default",
  size = "md",
  iconOnly = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = ["kd-btn", iconOnly ? "kd-btn-icon" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      data-variant={variant === "default" ? undefined : variant}
      data-size={size === "md" ? undefined : size}
    />
  );
}
