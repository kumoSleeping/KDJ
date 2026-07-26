import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";

const ROOT = path.join(__dirname, "..");
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// dev 才开 CDP 调试端口：改完界面能直接截图/查 DOM 核对。
// 放在代码里而不是启动参数里：vite-plugin-electron 的 :startup 钩子在
// main/preload 两个构建间共用计数器，谁后构建完就触发谁的 onstart，
// 只给 main 配 onstart 传参数是在赌构建顺序（输了就是默认 argv，端口悄悄消失）。
if (DEV_URL) {
  app.commandLine.appendSwitch("remote-debugging-port", "9333");
}

let win: BrowserWindow | null = null;
let sidecar: ChildProcessWithoutNullStreams | null = null;
let sidecarExited = false;

const token = randomBytes(24).toString("hex");

function log(line: string): void {
  process.stdout.write(`[kumodeck] ${line}\n`);
  win?.webContents.send("sidecar:log", line);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** 开发期用 sidecar/.venv；找不到就退回系统 python。 */
function pythonExecutable(): string {
  const candidates = [
    path.join(ROOT, "sidecar", ".venv", "bin", "python"),
    path.join(ROOT, "sidecar", ".venv", "Scripts", "python.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * sidecar 的启动方式，按优先级：
 * 1. 打包版：resources/sidecar-bin 里 PyInstaller 冻结出的独立可执行
 *    （venv 不可搬迁，所以发行版不带 venv，见 CI 工作流和 pyinstaller_entry.py）；
 * 2. 开发版：sidecar/.venv 的 python -m kumodeck。
 * 两者的命令行参数完全一致。
 */
function sidecarCommand(): { command: string; args: string[]; cwd: string } {
  const packaged = path.join(
    process.resourcesPath ?? "",
    "sidecar-bin",
    process.platform === "win32" ? "kumodeck-sidecar.exe" : "kumodeck-sidecar",
  );
  if (process.resourcesPath && existsSync(packaged)) {
    return { command: packaged, args: [], cwd: path.dirname(packaged) };
  }
  const devCwd = path.join(ROOT, "sidecar");
  return {
    command: pythonExecutable(),
    args: ["-u", "-m", "kumodeck"],
    cwd: existsSync(devCwd) ? devCwd : ROOT,
  };
}

async function waitForHealth(baseUrl: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (sidecarExited) throw new Error(`sidecar 已退出：${lastError || "见日志"}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { "X-KumoDeck-Token": token },
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`sidecar 启动超时：${lastError}`);
}

async function startSidecar(): Promise<string> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = path.join(app.getPath("userData"), "data");
  const downloadDir = path.join(app.getPath("music"), "KumoDeck");
  const { command, args, cwd } = sidecarCommand();

  log(`启动 sidecar：${command} --port ${port}`);
  sidecar = spawn(
    command,
    [
      ...args,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--token", token,
      "--data-dir", dataDir,
      "--download-dir", downloadDir,
    ],
    {
      cwd,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    },
  ) as ChildProcessWithoutNullStreams;

  sidecar.stdout.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));
  sidecar.stderr.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));
  sidecar.on("exit", (code) => {
    sidecarExited = true;
    log(`sidecar 退出，code=${code}`);
  });

  await waitForHealth(baseUrl);
  log(`sidecar 就绪：${baseUrl}`);
  return baseUrl;
}

function stopSidecar(): void {
  if (!sidecar || sidecar.killed) return;
  sidecar.kill("SIGTERM");
  const child = sidecar;
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 3000);
  sidecar = null;
}

async function createWindow(baseUrl: string): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: "#111113",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--kd-base=${baseUrl}`, `--kd-token=${token}`],
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = null));

  if (DEV_URL) {
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(ROOT, "dist", "index.html"));
  }
}

function showStartupFailure(error: Error): void {
  dialog.showErrorBox(
    "KumoDeck 启动失败",
    `${error.message}\n\n请先执行：npm run sidecar:setup\n（需要 Python 3.10+ 与 ffmpeg）`,
  );
  app.quit();
}

ipcMain.handle("shell:openPath", (_event, target: string) => shell.openPath(target));
ipcMain.handle("shell:revealPath", (_event, target: string) => shell.showItemInFolder(target));
ipcMain.handle("dialog:pickFolder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("dialog:pickFolders", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "multiSelections", "createDirectory"],
  });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.on("window:control", (_event, action: string) => {
  if (!win) return;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (action === "close") win.close();
});

app.whenReady().then(async () => {
  try {
    const baseUrl = await startSidecar();
    await createWindow(baseUrl);
  } catch (error) {
    showStartupFailure(error as Error);
  }
});

app.on("window-all-closed", () => {
  stopSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopSidecar);
process.on("exit", stopSidecar);
