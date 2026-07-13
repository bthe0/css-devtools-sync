import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { devSync } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap, mounts the apply engine on this
// server's own origin (/__dev-sync/*), and stamps JSX with source locations.
export default defineConfig({
  plugins: [devSync(), solid()],
  server: {
    port: 5799,
    strictPort: true,
  },
});
