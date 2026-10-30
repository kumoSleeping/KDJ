// @run tsx
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mediaProductionAvailable, visualizerPreviewBudget } from "../src/lib/platformFeatures";

test("mobile production policy leaves desktop and shared colour code available", () => {
  for (const platform of ["android", "ios"]) assert.equal(mediaProductionAvailable(platform), false);
  for (const platform of ["darwin", "linux", "win32", "browser"]) assert.equal(mediaProductionAvailable(platform), true);
});

test("a phone draws the visualizer at 30 fps on a smaller canvas, also full screen", () => {
  const phone = visualizerPreviewBudget("android"), desktop = visualizerPreviewBudget("darwin");
  assert.equal(phone.fps, 30);
  assert.equal(phone.fullscreenFps, 30);
  assert.equal(desktop.fullscreenFps, 60);
  assert.ok(phone.maxWidth < desktop.maxWidth && phone.fullscreenWidth < desktop.fullscreenWidth && phone.pixelRatio < desktop.pixelRatio);
});

test("Android module graph omits production panels/export worker, keeps the visualizer, YouTube runtime and palette", async () => {
  const original = process.env.TAURI_ENV_PLATFORM;
  process.env.TAURI_ENV_PLATFORM = "androideabi";
  try {
    const { default: config } = await import("../vite.tauri.config");
    const plugin = (config as any).plugins.find((item: any) => item.name === "kdj-mobile-media-panels");
    assert.ok(plugin);
    for (const name of ["LaneEditor", "KdjvLivePicture", "ExportQueuePanel", "AiPanel", "FfmpegPanel"]) {
      const id = plugin.resolveId(`../${name}`);
      assert.ok(id);
      assert.match(plugin.load(id), /return null/);
    }
    assert.match(plugin.load(plugin.resolveId("../visualizerStudioExport")), /throw new Error/);
    for (const name of ["VisualizerStudioPanel", "VisualizerPopup", "VisualizerDock", "visualizerStudioRenderer", "kdjvClock", "visualizerStudioPalette", "songColor", "youtubeNativePo", "youtubeSabr", "videoPlaybackEngine"]) {
      assert.equal(plugin.resolveId(`./${name}`), null);
    }
    assert.equal((config as any).resolve, undefined, "Android must not alias proof/SABR to unsupported");
  } finally {
    if (original === undefined) delete process.env.TAURI_ENV_PLATFORM; else process.env.TAURI_ENV_PLATFORM = original;
  }
});

test("postinit adds native PiP without broadening network permissions, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdj-android-manifest-"));
  try {
    const script = await readFile("scripts/android-postinit.sh", "utf8");
    const program = script.split('python3 - "$GRADLE" "$MANIFEST" <<\'PY\'\n')[1]?.split("\nPY")[0];
    assert.ok(program);
    const gradle = join(root, "build.gradle.kts"), manifest = join(root, "AndroidManifest.xml");
    await writeFile(gradle, 'manifestPlaceholders["usesCleartextTraffic"] = "true"');
    await writeFile(manifest, '<manifest><application><activity android:name=".MainActivity" android:configChanges="screenSize|orientation" /></application></manifest>');
    execFileSync("python3", ["-c", program!, gradle, manifest]);
    const result = await readFile(manifest, "utf8");
    assert.match(result, /android:supportsPictureInPicture="true"/);
    assert.match(result, /android:networkSecurityConfig="@xml\/kdj_network_security_config"/);
    assert.match(await readFile(gradle, "utf8"), /"false"/);
    execFileSync("python3", ["-c", program!, gradle, manifest]);
    assert.equal(await readFile(manifest, "utf8"), result);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("README size sync uses current Android APK and preserves prose/markers in both languages", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdj-android-readme-"));
  try {
    await mkdir(join(root, "scripts"));
    await copyFile("scripts/update-readme-release-sizes.mjs", join(root, "scripts/sync.mjs"));
    const original = "# KDJ\nAndroid information\n<!-- release-package-size-badges:start -->\nold\n<!-- release-package-size-badges:end -->\nlicense\n";
    for (const name of ["README.md", "README.en.md"]) await writeFile(join(root, name), original);
    const release = { tag_name: "v9.0.0-rc1", assets: ["KDJ_9.0.0-rc1_aarch64.dmg", "KDJ_9.0.0-rc1_x64.dmg", "KDJ_9.0.0-rc1_x64-setup.exe", "KDJ_9.0.0-rc1_amd64.deb", "app-arm64-release.apk"].map(name => ({ name, size: 1024 * 1024 })) };
    await writeFile(join(root, "release.json"), JSON.stringify(release));
    execFileSync(process.execPath, [join(root, "scripts/sync.mjs"), join(root, "release.json")]);
    for (const name of ["README.md", "README.en.md"]) {
      const result = await readFile(join(root, name), "utf8");
      assert.match(result, /v9\.0\.0-rc1\/app-arm64-release\.apk/);
      assert.match(result, /Android-1\.0_MB/);
      assert.ok(result.startsWith("# KDJ\nAndroid information\n"));
      assert.ok(result.endsWith("\nlicense\n"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
