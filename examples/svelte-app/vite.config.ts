import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { devSync } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*).
export default defineConfig({
  plugins: [svelte(), devSync()],
  server: {
    port: 5499,
    strictPort: true,
  },
});
