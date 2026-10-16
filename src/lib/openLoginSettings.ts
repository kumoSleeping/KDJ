import { useAppStore } from "../stores/appStore";
import { useLoginRequest, useSettingsPage } from "./settingsPages";

/** 登录在设置的「登录」页：先翻到那一页，再打开设置；给了平台，就把那个账号的登录方式展开。 */
export function openLoginSettings(platform?: string): void {
  if (platform) useLoginRequest.getState().ask(platform);
  useSettingsPage.getState().setPage("sources");
  useAppStore.getState().openSettingsPanel();
}
