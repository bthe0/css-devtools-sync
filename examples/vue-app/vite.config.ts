import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { devSync, sourceLocatorVue } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*). sourceLocatorVue() stamps each
// static element with its source location for DevTools markup sync; its
// `enforce: "pre"` runs it before @vitejs/plugin-vue (on raw .vue source) and
// `apply: "serve"` ships nothing to production builds.
export default defineConfig({
  plugins: [sourceLocatorVue(), vue(), devSync()],
  server: {
    port: 5399,
    strictPort: true,
  },
});
