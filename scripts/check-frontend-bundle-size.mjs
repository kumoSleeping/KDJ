import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-tauri");
const platform = process.env.TAURI_ENV_PLATFORM || process.platform;

function report(level, message) {
  console.error(`::${level}::${message}`);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function main() {
  let files;
  try {
    files = await collectFiles(dist);
  } catch (error) {
    if (error?.code === "ENOENT") {
      report("error", `${dist} 不存在，先构建 Tauri 前端`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (files.some((file) => file.endsWith(".map"))) {
    report("error", "release 前端产物不允许包含 source map");
    process.exitCode = 1;
    return;
  }

  const assets = files.filter((file) => path.dirname(file) === path.join(dist, "assets"));
  const mainJs = assets.filter((file) => /^index-[^/]+\.js$/.test(path.basename(file)));
  const cssAssets = assets.filter((file) => file.endsWith(".css"));
  if (mainJs.length !== 1 || cssAssets.length === 0) {
    report(
      "error",
      `前端主产物数量异常：入口 JS=${mainJs.length}，CSS=${cssAssets.length}`,
    );
    process.exitCode = 1;
    return;
  }

  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
  const mainJsBytes = (await stat(mainJs[0])).size;
  const cssBytes = (await Promise.all(cssAssets.map(async (file) => (await stat(file)).size)))
    .reduce((sum, bytes) => sum + bytes, 0);
  const nativeProofWorker = assets.some((file) => (
    /^youtubeNativePo\.worker-[^/]+\.js$/.test(path.basename(file))
  ));
  const desktopProof = ["darwin", "linux", "windows", "win32"].includes(platform);
  const maxTotal = desktopProof ? 1_500_000 : 1_250_000;

  console.log(
    `Frontend bundle (${platform}): total=${total} B, `
      + `entry-js=${mainJsBytes} B, all-css=${cssBytes} B`,
  );

  let failed = false;
  if (!desktopProof && nativeProofWorker) {
    report("error", `${platform} 不应打包桌面专用 YouTube proof worker`);
    failed = true;
  }
  if (desktopProof && !nativeProofWorker) {
    report("error", `${platform} 缺少 YouTube proof worker 产物`);
    failed = true;
  }
  if (total > maxTotal) {
    report("error", `前端总产物 ${total} B 超过 ${platform} 预算 ${maxTotal} B`);
    failed = true;
  }
  if (mainJsBytes > 1_050_000) {
    report("error", `前端主 JS ${mainJsBytes} B 超过 1050000 B 预算`);
    failed = true;
  }
  if (cssBytes > 200_000) {
    report("error", `前端全部 CSS ${cssBytes} B 超过 200000 B 预算`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  report("error", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
