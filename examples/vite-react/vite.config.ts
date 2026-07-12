import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devSync } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap, mounts the apply engine on this
// server's own origin (/__dev-sync/*), and stamps JSX with source locations.
export default defineConfig({
  plugins: [react(), devSync()],
  server: {
    port: 5299,
    strictPort: true,
  },
});
