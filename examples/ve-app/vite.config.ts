import { defineConfig } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { devSync } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*).
// vanillaExtractPlugin() is left in its default mode (no inlineCssInDev) so
// the served CSS comes from the per-file virtual `*.css.ts.vanilla.css`
// module instead of an inlined <style> tag.
export default defineConfig({
  plugins: [vanillaExtractPlugin(), devSync()],
  server: {
    port: 5599,
    strictPort: true,
  },
});
