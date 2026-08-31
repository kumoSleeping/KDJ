import type { SVGProps } from "react";

export interface HintBulbIconProps
  extends Omit<SVGProps<SVGSVGElement>, "height" | "width"> {
  size?: number;
}

/** 极简灯罩与底座，专门用于搜索提示入口。 */
export function HintBulbIcon({ size = 14, ...props }: HintBulbIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      focusable="false"
      {...props}
    >
      <path
        d="M8 2.35a4 4 0 0 0-2.48 7.14c.5.4.8 1.02.8 1.66v.1h3.36v-.1c0-.64.3-1.26.8-1.66A4 4 0 0 0 8 2.35Z"
        fill="currentColor"
        fillOpacity="0.07"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.48 12.85h3.04M6.92 14.35h2.16"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </svg>
  );
}
