import { sourceLocator } from "@css-sync/babel-plugin-source-locator/vite";
import type { Plugin } from "vite";

export interface CssSyncOptions {
  /**
   * Project root used to relativise stamped source paths. Defaults to Vite's
   * resolved `config.root` (or `process.cwd()` before resolve).
   */
  root?: string;
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
 * extension can map a Styles-panel edit back to source, and (2) stamps JSX host
 * elements with their source location via the shared Babel plugin. Both are
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

  return [configPlugin, sourceLocator({ root: options.root })];
}

export default cssSync;
