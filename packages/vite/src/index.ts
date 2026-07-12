import { sourceLocator } from "@css-sync/babel-plugin-source-locator/vite";
import { configFromRoot, createApplyMiddleware } from "@css-sync/server/engine";
import type { Plugin } from "vite";

/** Path prefix the embedded apply engine is mounted under on the dev server. */
export const MOUNT_PREFIX = "/__css-sync";

export interface CssSyncOptions {
  /**
   * Project root used to relativise stamped source paths. Defaults to Vite's
   * resolved `config.root` (or `process.cwd()` before resolve).
   */
  root?: string;
  /**
   * Mount the embedded apply engine on the dev server (so the extension POSTs
   * the page's own origin at `/__css-sync/*`). Default `true`. Set `false` to
   * only enable the CSS sourcemap + JSX stamping and run the engine elsewhere.
   */
  engine?: boolean;
}

/**
 * Drop-in Vite integration for css-devtools-sync. Add once to `plugins`:
 *
 * ```ts
 * import { cssSync } from "@css-sync/vite";
 * export default defineConfig({ plugins: [react(), cssSync()] });
 * ```
 *
 * Returns an array Vite flattens. It (1) turns on the CSS dev sourcemap so the
 * extension can map a Styles-panel edit back to source, (2) mounts the apply
 * engine on the dev server's own origin at `/__css-sync/*` (no separate port),
 * and (3) stamps JSX host elements with their source location. All three are
 * dev-serve-only (`apply: "serve"`); production builds are untouched.
 */
export function cssSync(options: CssSyncOptions = {}): Plugin[] {
  const configPlugin: Plugin = {
    name: "css-sync:config",
    apply: "serve",
    config() {
      return { css: { devSourcemap: true } };
    },
  };

  const enginePlugin: Plugin = {
    name: "css-sync:engine",
    apply: "serve",
    configureServer(server) {
      // Root is the bundler's project root — every engine write is jailed under it.
      const cfg = configFromRoot(options.root ?? server.config.root);
      server.middlewares.use(MOUNT_PREFIX, createApplyMiddleware(cfg));
    },
  };

  const plugins: Plugin[] = [configPlugin];
  if (options.engine !== false) plugins.push(enginePlugin);
  plugins.push(sourceLocator({ root: options.root }));
  return plugins;
}

export default cssSync;
