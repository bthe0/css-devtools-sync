import { devSync, sourceLocatorVue } from "@dev-sync/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
// devSync() turns on the CSS dev sourcemap and stamps SFC/JSX source locations.
// Nuxt forwards `vite.plugins` into its internal Vite dev server config, but the
// apply engine can NOT ride Vite's connect stack here: Nitro owns HTTP routing
// and intercepts /__dev-sync/* before Vite sees it (see nuxt 4 middleware-mode).
// So we pass `engine: false` and mount the engine on Nitro instead, in
// server/middleware/dev-sync.ts.
//
// devSync() only wires the JSX/TSX source-locator; Nuxt renders .vue SFCs, whose
// template elements are stamped by sourceLocatorVue() (enforce:"pre" → runs on
// raw .vue source before Nuxt's internal @vitejs/plugin-vue). Without it, .vue
// elements carry no runtime __srcLoc and DevTools markup sync captures nothing.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-13",
  devServer: {
    port: 5899,
  },
  vite: {
    server: {
      strictPort: true,
    },
    plugins: [sourceLocatorVue(), devSync({ engine: false })],
  },
});
