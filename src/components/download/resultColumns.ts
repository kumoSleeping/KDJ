/**
 * 下载搜索结果表的数据列定义。
 * 勾选列和行首动作列固定在左侧，不参与换序/显隐。
 */

export interface ResultColumn {
  key: string;
  label: string;
  width: string;
  align?: "num";
  /** false = 选列菜单里不能藏（标题）。缺省 true。 */
  hideable?: boolean;
}

export const RESULT_COLUMNS: ResultColumn[] = [
  { key: "title", label: "标题", width: "14rem", hideable: false },
  { key: "artist", label: "艺人", width: "6.5rem" },
  { key: "album", label: "专辑", width: "5.75rem" },
  { key: "duration", label: "时长", width: "4.5rem", align: "num" },
  { key: "sources", label: "来源", width: "4.5rem" },
  { key: "from", label: "下载自", width: "4.5rem" },
  { key: "quality", label: "音质", width: "4rem", align: "num" },
  { key: "vip", label: "VIP", width: "3rem" },
];

export const RESULT_LEAD_WIDTH = "2.1rem";
export const RESULT_COLUMN_PREFS_KEY = "kd-download-columns";

export const RESULT_COLUMN_MIN_WIDTH: Record<string, string> = {
  lead: "1.75rem",
  title: "8rem",
  artist: "3rem",
  album: "3rem",
  duration: "2.8rem",
  sources: "3rem",
  from: "3rem",
  quality: "2.8rem",
  vip: "2.4rem",
};
