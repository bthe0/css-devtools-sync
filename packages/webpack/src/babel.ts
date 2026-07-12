/**
 * JSX source stamping for Next runs through Babel (Next auto-switches off SWC when
 * a Babel config is present). Prefer a static `.babelrc`:
 *
 * ```json
 * { "presets": ["next/babel"], "plugins": [["@dev-sync/babel-plugin-source-locator", { "root": ".", "requireUseClientDirective": true }]] }
 * ```
 *
 * For a programmatic `babel.config.js`, use `devSyncBabelConfig()`.
 */

/** Package name of the source-locator Babel plugin (for `.babelrc` authors). */
export const SOURCE_LOCATOR_PLUGIN = "@dev-sync/babel-plugin-source-locator";

export interface DevSyncBabelOptions {
  /** Root used to relativise stamped `__srcLoc` paths. Defaults to the app dir. */
  root?: string;
}

interface SourceLocatorPluginOptions {
  root?: string;
  requireUseClientDirective: boolean;
}

/** A ready Babel config that keeps Next's preset and adds the source-locator plugin. */
export function devSyncBabelConfig(options: DevSyncBabelOptions = {}): {
  presets: string[];
  plugins: Array<[string, SourceLocatorPluginOptions]>;
} {
  // `requireUseClientDirective` is mandatory under Next: the stamp attaches a
  // `ref`, illegal in a Server Component (App Router default), so stamping is
  // gated to "use client" modules — otherwise every route 500s.
  const pluginOpts: SourceLocatorPluginOptions = { requireUseClientDirective: true };
  if (options.root) pluginOpts.root = options.root;
  return {
    presets: ["next/babel"],
    plugins: [[SOURCE_LOCATOR_PLUGIN, pluginOpts]],
  };
}

export default devSyncBabelConfig;
