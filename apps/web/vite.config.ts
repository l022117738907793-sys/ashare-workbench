import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `base: "./"` 是硬要求：产物要能挂在 GitHub Pages 的子路径下
 * （例如 `https://user.github.io/ashare-workbench/`），所有资源必须是相对路径。
 *
 * `@aw/core` / `@aw/data` 是 workspace 包，`main` 直接指向 TS 源码。
 * 这里再做一次 alias，避免依赖 npm 软链是否被正确 hoist。
 * 用正则精确匹配包名，保证 `@aw/core/rules.json` 这类子路径不被误伤。
 */
const coreSrc = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));
const dataSrc = fileURLToPath(new URL("../../packages/data/src/index.ts", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@aw\/core$/, replacement: coreSrc },
      { find: /^@aw\/data$/, replacement: dataSrc },
    ],
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
