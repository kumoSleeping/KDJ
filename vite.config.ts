import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

// main / preload 都强制打成 CJS：Electron 的 preload 在 contextIsolation 下
// 只有 CJS 是无条件可用的，ESM preload 需要 sandbox:false，不值得为此放宽沙箱。
const cjsOutput = {
  format: "cjs" as const,
  entryFileNames: "[name].js",
};

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        // 调试端口在 electron/main.ts 里用 appendSwitch 开（只限 dev）。
        // 不要在这里用 onstart 传启动参数：插件的 :startup 钩子在 main/preload
        // 两个构建间共用计数器，实际触发哪个 onstart 取决于构建完成顺序。
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { output: cjsOutput, external: ["electron"] },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { output: cjsOutput, external: ["electron"] },
          },
        },
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
