/**
 * 全局共用活动区已拆成各板块自有工作条（LibraryWorkRail / SearchWorkRail）。
 * 这里只保留分析小波形，供曲库工作条复用。
 */
export function AnalysisGlyph() {
  return (
    <svg className="kd-activity-glyph kd-activity-glyph-wave" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="5" width="2.2" height="6" rx="0" />
      <rect x="4.9" y="2" width="2.2" height="12" rx="0" />
      <rect x="8.8" y="4" width="2.2" height="8" rx="0" />
      <rect x="12.7" y="6" width="2.2" height="4" rx="0" />
    </svg>
  );
}
