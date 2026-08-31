import { useEffect, useState, type ReactNode } from "react";

/** 没有封面时使用的小黑胶唱盘；尺寸跟随父容器，列表和详情共用同一张脸。 */
export function VinylPlaceholder({ className = "" }: { className?: string }) {
  return (
    <span className={`kd-vinyl-placeholder ${className}`.trim()} aria-hidden="true">
      <span className="kd-vinyl-placeholder-label" />
    </span>
  );
}

/** 图片加载失败时直接换唱盘，不留下破图标或空白方块。 */
export function CoverImage({
  src,
  alt = "",
  className,
  loading,
  draggable = false,
  referrerPolicy,
  onLoad,
  fallback,
}: {
  src: string;
  alt?: string;
  className?: string;
  loading?: "eager" | "lazy";
  draggable?: boolean;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  onLoad?: () => void;
  /** 某些入口有比唱盘更准确的空封面语义，例如歌单搜索用列表图标。 */
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(!src);

  useEffect(() => setFailed(!src), [src]);

  if (failed) return fallback ?? <VinylPlaceholder />;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      draggable={draggable}
      referrerPolicy={referrerPolicy}
      onLoad={onLoad}
      onError={() => setFailed(true)}
    />
  );
}
