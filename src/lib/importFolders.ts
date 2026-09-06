import { useAppStore } from "../stores/appStore";
import { useLibraryStore } from "../stores/libraryStore";

/** 系统选择器与系统拖入共用的添加流程：登记目录、扫描，并沿用自动分析设置。 */
export async function importFolders(paths: string[]): Promise<void> {
  const folders = [...new Set(paths.filter((path) => path.trim().length > 0))];
  // 取消选择或只拖入普通文件时不发送导入请求；后端也拒绝空列表。
  if (!folders.length) return;
  const autoAnalyze = useAppStore.getState().settings?.auto_analyze ?? true;
  await useLibraryStore.getState().startScan(folders, autoAnalyze);
  // 扫描数量通过事件返回；安卓额外检查权限，区分无权限和空目录。
  if (
    window.kdj?.mediaPermissionGranted &&
    !(await window.kdj.mediaPermissionGranted())
  ) {
    throw new Error(
      "没有在手机存储里找到音乐。KDJ 需要「媒体和照片」权限才能读取公共 Music 目录——请到 系统设置 → 应用 → KDJ → 权限 里允许后，再点一次添加。",
    );
  }
}

export async function pickAndScanFolders(): Promise<void> {
  await importFolders(await window.kdj?.pickFolders() ?? []);
}
