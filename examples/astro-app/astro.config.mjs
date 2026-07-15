import { defineConfig } from "astro/config";
import { devSync, sourceLocatorAstro } from "@dev-sync/vite";

// https://astro.build/config
// devSync() turns on the CSS dev sourcemap and mounts the apply engine on
// this server's own origin (/__dev-sync/*), injected through Astro's own
// Vite instance via the `vite` config key. sourceLocatorAstro() stamps each
// static element with a transient `data-devloc` on the raw `.astro` source
// (`enforce: "pre"`, so it runs before Astro's compiler) and injects a client
// harvest script that lifts it into the framework-neutral `__srcLoc` property.
export default defineConfig({
  server: {
    port: 5699,
  },
  vite: {
    plugins: [sourceLocatorAstro(), devSync()],
    server: {
      strictPort: true,
    },
  },
});
