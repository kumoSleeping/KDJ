import { contextBridge, ipcRenderer } from "electron";

function argValue(prefix: string): string {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("kumodeck", {
  baseUrl: argValue("--kd-base="),
  token: argValue("--kd-token="),
  platform: process.platform,
  openPath: (target: string) => ipcRenderer.invoke("shell:openPath", target),
  revealPath: (target: string) => ipcRenderer.invoke("shell:revealPath", target),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickFolders: () => ipcRenderer.invoke("dialog:pickFolders"),
  windowControl: (action: "minimize" | "maximize" | "close") =>
    ipcRenderer.send("window:control", action),
  onSidecarLog: (callback: (line: string) => void) => {
    const handler = (_event: unknown, line: string) => callback(line);
    ipcRenderer.on("sidecar:log", handler);
    return () => ipcRenderer.off("sidecar:log", handler);
  },
});
