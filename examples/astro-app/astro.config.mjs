import { defineConfig } from "astro/config";
import { devSync } from "@dev-sync/vite";

// https://astro.build/config
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*), injected through Astro's own
// Vite instance via the `vite` config key.
export default defineConfig({
  server: {
    port: 5699,
  },
  vite: {
    plugins: [devSync()],
    server: {
      strictPort: true,
    },
  },
});
