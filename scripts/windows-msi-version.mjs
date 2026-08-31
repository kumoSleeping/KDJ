#!/usr/bin/env node

import { readFileSync } from "node:fs";

const PRERELEASE_STAGES = new Map([
  ["alpha", 10_000],
  ["beta", 20_000],
  ["rc", 30_000],
]);
const MAX_STAGE_SEQUENCE = 9_999;

function fail(message) {
  throw new Error(message);
}

function parseBoundedInteger(value, label, maximum) {
  const parsed = BigInt(value);
  if (parsed > BigInt(maximum)) {
    fail(`${label} 不能大于 ${maximum}（实际：${value}）`);
  }
  return Number(parsed);
}

function prereleaseBuild(prerelease) {
  if (/^\d+$/.test(prerelease)) {
    return parseBoundedInteger(
      prerelease,
      "Windows MSI 数字预发行序号",
      MAX_STAGE_SEQUENCE,
    );
  }

  const match = /^(alpha|beta|rc)(?:[.-]?(\d+))?$/i.exec(prerelease);
  if (!match) {
    fail(
      `Windows MSI 不支持预发行标识 ${prerelease}；请使用数字、alphaN、betaN 或 rcN`,
    );
  }

  const stage = match[1].toLowerCase();
  const sequence = match[2]
    ? parseBoundedInteger(
        match[2],
        `Windows MSI ${stage} 序号`,
        MAX_STAGE_SEQUENCE,
      )
    : 0;
  return PRERELEASE_STAGES.get(stage) + sequence;
}

/**
 * WiX only accepts numeric MSI versions. Keep the public SemVer untouched and
 * map its prerelease stage into the optional fourth MSI field instead. The
 * public patch is doubled and stable builds use the following internal patch,
 * so 1.0.0 (1.0.1.0 internally) upgrades 1.0.0-rcN (1.0.0.N internally) even
 * on Windows Installer versions that compare only the first three fields.
 */
export function windowsMsiVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
    version,
  );
  if (!match) {
    fail(`版本号不合法：${version}`);
  }

  const major = parseBoundedInteger(match[1], "Windows MSI major", 255);
  const minor = parseBoundedInteger(match[2], "Windows MSI minor", 255);
  const publicPatch = parseBoundedInteger(
    match[3],
    "Windows MSI 公开 patch",
    32_767,
  );
  const isPrerelease = Boolean(match[4]);
  const patch = publicPatch * 2 + (isPrerelease ? 0 : 1);
  const build = isPrerelease ? prereleaseBuild(match[4]) : 0;

  return `${major}.${minor}.${patch}.${build}`;
}

function currentVersion() {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  if (typeof config.version !== "string") {
    fail("src-tauri/tauri.conf.json 缺少字符串 version");
  }
  return config.version;
}

function main() {
  const args = process.argv.slice(2);
  const configOutput = args.includes("--config");
  const positional = args.filter((arg) => arg !== "--config");
  if (positional.length > 1) {
    fail("用法：node scripts/windows-msi-version.mjs [--config] [version]");
  }

  const version = positional[0] ?? currentVersion();
  const msiVersion = windowsMsiVersion(version);
  if (configOutput) {
    console.log(
      JSON.stringify({ bundle: { windows: { wix: { version: msiVersion } } } }),
    );
  } else {
    console.log(msiVersion);
  }
}

if (process.argv[1]?.endsWith("windows-msi-version.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
