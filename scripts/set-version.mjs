#!/usr/bin/env node
/** 同步修改 Tauri/npm/Cargo 三处版本号，避免安装包和运行时显示不同版本。 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("用法：node scripts/set-version.mjs <x.y.z>，例如 0.2.2");
  process.exit(2);
}

for (const path of ["package.json", "src-tauri/tauri.conf.json"]) {
  const source = readFileSync(path, "utf8");
  const versionField = /("version"\s*:\s*")[^"]+("\s*,)/;
  if (!versionField.test(source)) {
    console.error(`${path} 没有找到顶层 version 字段`);
    process.exit(1);
  }
  writeFileSync(path, source.replace(versionField, `$1${version}$2`));
}

const cargoPath = "Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const workspaceVersion = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]+("\s*\n)/;
if (!workspaceVersion.test(cargo)) {
  console.error("没有在 Cargo.toml 的 [workspace.package] 找到可替换版本号");
  process.exit(1);
}
const nextCargo = cargo.replace(workspaceVersion, `$1${version}$2`);
writeFileSync(cargoPath, nextCargo);

// path dependency 同时写了 version 约束；只涨 workspace.package 而不涨这里，
// 一跨 minor/major Cargo 就会以“本地包版本不满足 ^旧版”拒绝构建。
const memberManifests = [
  "src-tauri/Cargo.toml",
  ...readdirSync("crates", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `crates/${entry.name}/Cargo.toml`)
    .filter(existsSync),
];
for (const path of memberManifests) {
  const source = readFileSync(path, "utf8");
  const next = source.replace(
    /(kdj-[a-z-]+\s*=\s*\{\s*version\s*=\s*")[^"]+("\s*,\s*path\s*=)/g,
    `$1${version}$2`,
  );
  writeFileSync(path, next);
}

// 刷新 Cargo.lock 里 workspace 包的版本；失败时不吞错误。
const cargoMetadata = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
  stdio: ["ignore", "ignore", "inherit"],
});
if (cargoMetadata.status !== 0) process.exit(cargoMetadata.status ?? 1);

console.log(`✓ KDJ 版本已同步为 ${version}`);
