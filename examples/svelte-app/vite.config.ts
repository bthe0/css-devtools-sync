import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { devSync, sourceLocatorSveltePreprocess } from "@dev-sync/vite";

// https://vite.dev/config/
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*). In dev we ALSO run the Svelte
// source-locator preprocessor FIRST (before vitePreprocess) so each static
// element is stamped with its source location for DevTools markup sync. It is
// gated to `command === "serve"` so production builds ship no `use:` actions.
export default defineConfig(({ command }) => ({
  plugins: [
    svelte({
      preprocess:
        command === "serve"
          ? [sourceLocatorSveltePreprocess({ root: import.meta.dirname }), vitePreprocess()]
          : [vitePreprocess()],
    }),
    devSync(),
  ],
  server: {
    port: 5499,
    strictPort: true,
  },
}));
