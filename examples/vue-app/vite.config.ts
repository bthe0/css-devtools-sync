import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { devSync } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*).
export default defineConfig({
  plugins: [vue(), devSync()],
  server: {
    port: 5399,
    strictPort: true,
  },
});
