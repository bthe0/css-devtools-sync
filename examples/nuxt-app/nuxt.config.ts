import { devSync } from "@dev-sync/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*). Nuxt forwards `vite.plugins`
// straight into its internal Vite dev server config.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-13",
  devServer: {
    port: 5899,
  },
  vite: {
    server: {
      strictPort: true,
    },
    plugins: [devSync()],
  },
});
