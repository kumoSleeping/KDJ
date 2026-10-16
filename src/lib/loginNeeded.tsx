import { LogIn } from "lucide-react";
import { dismissTask, showTask } from "../components/tasks/taskBubbleStore";
import { openLoginSettings } from "./openLoginSettings";

/** Codes the local API answers with when going on needs the listener to log in (again). */
export type LoginNeededCode = "AUTH_EXPIRED" | "AUTH_REQUIRED";

/** The login code of a failed local API call, read off the body `ApiError` keeps as `detail`. */
export function loginNeededCode(error: unknown): LoginNeededCode | null {
  const body = error && typeof error === "object" ? (error as { detail?: unknown }).detail : undefined;
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return code === "AUTH_EXPIRED" || code === "AUTH_REQUIRED" ? code : null;
}

const SOURCE_NAMES = { youtube: "YouTube" } as const;

/**
 * A playback or download that stopped for a login says so in one bubble per source, with the key
 * that opens that source's ways to log in. False when the failure was something else.
 */
export function reportLoginNeeded(platform: keyof typeof SOURCE_NAMES, error: unknown): boolean {
  const code = loginNeededCode(error);
  if (!code) return false;
  const id = `login-needed:${platform}`;
  const open = () => {
    dismissTask(id);
    openLoginSettings(platform);
  };
  const name = SOURCE_NAMES[platform];
  showTask({
    id,
    kind: "notice",
    title: code === "AUTH_EXPIRED" ? `${name} 登录已失效` : `${name} 需要先登录`,
    tone: "error",
    actions: [{ id: "login", label: "登录", icon: <LogIn size={14} />, onSelect: open }],
    onOpen: open,
  });
  return true;
}
