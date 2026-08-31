import type { IntakeItem, MergedGroup, VideoInfo } from "../../types";

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

export const RESULT_LEAD_WIDTH = "2.5rem";
export const RESULT_COLUMN_PREFS_KEY = "kd-download-columns";

export const RESULT_COLUMN_MIN_WIDTH: Record<string, string> = {
  lead: "2.25rem",
  title: "8rem",
  artist: "3rem",
  album: "3rem",
  duration: "2.8rem",
  sources: "3rem",
  from: "3rem",
  quality: "2.8rem",
  vip: "2.4rem",
};

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function isStandaloneVideoGroup(group: MergedGroup): boolean {
  const platform = group.sources[0]?.platform;
  return (
    (platform === "bilibili" || platform === "youtube") &&
    group.sources.every((source) => source.platform === platform)
  );
}

/**
 * 搜索结果里整列都没有真实内容时，不让一列 "—" 挡住标题。
 *
 * 这里返回的是数据实际能填充的列；用户手动隐藏的偏好仍由 ResultTable
 * 叠加处理。下一次搜索出现对应元数据时，该列会自然恢复。
 */
export function resultColumnKeysWithData(
  items: ReadonlyArray<IntakeItem>,
  video: VideoInfo | null,
): ReadonlySet<string> {
  const present = new Set<string>(["title"]);

  if (video) {
    present.add("sources");
    present.add("from");
    present.add("quality");
    if (hasText(video.author)) present.add("artist");
    if (video.duration > 0 || video.pages.some((page) => page.duration > 0)) {
      present.add("duration");
    }
  }

  for (const item of items) {
    for (const collection of item.collections) {
      present.add("sources");
      if (hasText(collection.subtitle)) present.add("artist");
      if (collection.count > 0) present.add("duration");
    }

    for (const group of item.groups) {
      if (
        group.artists.some(hasText) ||
        group.sources.some((source) => source.artists.some(hasText))
      ) {
        present.add("artist");
      }
      if (
        hasText(group.album) ||
        group.sources.some((source) => hasText(source.album))
      ) {
        present.add("album");
      }
      if (
        group.duration !== null ||
        group.sources.some((source) => source.duration !== null)
      ) {
        present.add("duration");
      }
      if (group.sources.length > 0) {
        present.add("sources");
        present.add("from");
      }
      if (
        isStandaloneVideoGroup(group) ||
        group.sources.some((source) => source.max_quality !== null)
      ) {
        present.add("quality");
      }
      if (group.sources.some((source) => source.vip)) present.add("vip");
    }
  }

  return present;
}
