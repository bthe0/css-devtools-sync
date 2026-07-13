import { devSync } from "@dev-sync/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
// devSync() turns on the CSS dev sourcemap and stamps SFC/JSX source locations.
// Nuxt forwards `vite.plugins` into its internal Vite dev server config, but the
// apply engine can NOT ride Vite's connect stack here: Nitro owns HTTP routing
// and intercepts /__dev-sync/* before Vite sees it (see nuxt 4 middleware-mode).
// So we pass `engine: false` and mount the engine on Nitro instead, in
// server/middleware/dev-sync.ts.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-13",
  devServer: {
    port: 5899,
  },
  vite: {
    server: {
      strictPort: true,
    },
    plugins: [devSync({ engine: false })],
  },
});
