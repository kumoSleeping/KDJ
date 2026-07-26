import type { ReactNode } from "react";

export type BadgeTone = "theme" | "neutral" | "ok" | "warn";

export interface CornerBadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
}

/** 招牌红角标。挂在任意 position:relative 容器（.kd-panel / .kd-relative）的左上角外侧。 */
export function CornerBadge({ children, tone = "theme" }: CornerBadgeProps) {
  return (
    <span className="kd-corner-badge" data-tone={tone}>
      {children}
    </span>
  );
}
