import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INCOMPLETE_RELEASE_EXIT_CODE = 2;
const START_MARKER = "<!-- release-package-size-badges:start -->";
const END_MARKER = "<!-- release-package-size-badges:end -->";
const LATEST_RELEASE_URL =
  "https://github.com/kumoSleeping/KDJ/releases/latest";

function fail(message) {
  throw new Error(message);
}

function getAsset(assetsByName, name, missing) {
  const asset = assetsByName.get(name);
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    missing.push(name);
    return null;
  }
  return asset;
}

function sizeInMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function renderBadge({ label, size, color, logo, logoColor }) {
  const badgeSize = `${size}_MB`;
  return `  <a href="${LATEST_RELEASE_URL}"><img src="https://img.shields.io/badge/${label}-${badgeSize}-${color}?style=for-the-badge&logo=${logo}&logoColor=${logoColor}" alt="${label} ${size} MB"></a>`;
}

function replaceGeneratedBlock(source, generatedBlock, readmePath) {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) {
    fail(`${readmePath} 缺少 Release 体积标记，拒绝改写`);
  }
  if (
    source.indexOf(START_MARKER, start + START_MARKER.length) >= 0 ||
    source.indexOf(END_MARKER, end + END_MARKER.length) >= 0
  ) {
    fail(`${readmePath} 包含重复的 Release 体积标记，拒绝改写`);
  }

  const replacement = `${START_MARKER}\n${generatedBlock}\n${END_MARKER}`;
  return `${source.slice(0, start)}${replacement}${source.slice(
    end + END_MARKER.length,
  )}`;
}

async function main() {
  const releaseJsonPath = process.argv[2];
  if (!releaseJsonPath) {
    fail("用法：node scripts/update-readme-release-sizes.mjs <release.json>");
  }

  const release = JSON.parse(await readFile(releaseJsonPath, "utf8"));
  const tag = release.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail(`Release tag 不合法：${String(tag)}`);
  }
  if (!Array.isArray(release.assets)) {
    fail(`${tag} 的 assets 不是数组`);
  }

  const version = tag.slice(1);
  const assetsByName = new Map(
    release.assets.map((asset) => [asset.name, asset]),
  );
  const missing = [];

  // macOS / Windows / Android 使用用户最常下载的安装包；Linux 在三种正式包中
  // 选择体积最小的一个。所有文件名都精确匹配，避免把 Labs、签名或更新清单算入。
  const macOSArm64 = getAsset(
    assetsByName,
    `KDJ_${version}_aarch64.dmg`,
    missing,
  );
  const macOSX64 = getAsset(
    assetsByName,
    `KDJ_${version}_x64.dmg`,
    missing,
  );
  const windows = getAsset(
    assetsByName,
    `KDJ_${version}_x64-setup.exe`,
    missing,
  );
  const android = getAsset(assetsByName, "app-arm64-release.apk", missing);
  const linuxCandidates = [
    `KDJ_${version}_amd64.deb`,
    `KDJ-${version}-1.x86_64.rpm`,
    `KDJ_${version}_amd64.AppImage`,
  ]
    .map((name) => assetsByName.get(name))
    .filter(
      (asset) => asset && Number.isSafeInteger(asset.size) && asset.size > 0,
    );

  if (linuxCandidates.length === 0) {
    missing.push(`Linux stable package for ${version}`);
  }
  if (missing.length > 0) {
    console.error(
      `${tag} 的四平台 Release 资产尚未到齐：${missing.join(", ")}`,
    );
    process.exitCode = INCOMPLETE_RELEASE_EXIT_CODE;
    return;
  }

  const linux = linuxCandidates.sort((left, right) => left.size - right.size)[0];
  // README 只放一个 macOS 体积徽章：取两架构中较大的一个，
  // 这样对任意 Mac 用户都是保守上限，同时强制两个 DMG 都到齐才更新 README。
  const sizes = {
    macOS: sizeInMb(Math.max(macOSArm64.size, macOSX64.size)),
    macOSArm64: sizeInMb(macOSArm64.size),
    macOSX64: sizeInMb(macOSX64.size),
    Windows: sizeInMb(windows.size),
    Linux: sizeInMb(linux.size),
    Android: sizeInMb(android.size),
  };

  const generatedBlock = [
    "<p>",
    renderBadge({
      label: "macOS",
      size: sizes.macOS,
      color: "black",
      logo: "apple",
      logoColor: "white",
    }),
    renderBadge({
      label: "Windows",
      size: sizes.Windows,
      color: "0078D4",
      logo: "windows",
      logoColor: "white",
    }),
    renderBadge({
      label: "Linux",
      size: sizes.Linux,
      color: "FCC624",
      logo: "linux",
      logoColor: "black",
    }),
    renderBadge({
      label: "Android",
      size: sizes.Android,
      color: "3DDC84",
      logo: "android",
      logoColor: "white",
    }),
    "</p>",
  ].join("\n");

  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  for (const readmeName of ["README.md", "README.en.md"]) {
    const readmePath = path.join(repoRoot, readmeName);
    const source = await readFile(readmePath, "utf8");
    const updated = replaceGeneratedBlock(source, generatedBlock, readmeName);
    if (updated !== source) {
      await writeFile(readmePath, updated);
    }
  }

  console.log(
    `${tag}: macOS arm64 DMG ${sizes.macOSArm64} MB, x64 DMG ${sizes.macOSX64} MB; ` +
      `Windows EXE ${sizes.Windows} MB; ` +
      `Linux ${linux.name} ${sizes.Linux} MB; Android APK ${sizes.Android} MB`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
