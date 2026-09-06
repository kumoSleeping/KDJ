// V2 一次性重置升级前的详情排序，让视频优先；用户之后拖动的顺序仍长期保存。
// 本地与在线曲目继续共用同一份排序，避免切换曲目类型时丢失新调整。
export const DETAIL_PANELS_STORAGE_KEY = "kd-detail-panels-v2";
export const DETAIL_PANELS_DEFAULT_FIRST_IDS = ["video", "now-playing-control"] as const;
