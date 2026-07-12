import type { NextConfig } from "next";

/** Next's own webpack-callback context type, derived so we stay in lockstep. */
type WebpackContext = Parameters<NonNullable<NextConfig["webpack"]>>[1];

/** Page-origin prefix the extension POSTs to (same as the Vite integration). */
export const MOUNT_PREFIX = "/__dev-sync";
/** Internal Next API route the prefix is rewritten onto (a pages/api handler). */
export const ENGINE_API_PATH = "/api/__dev-sync";

export interface DevSyncNextOptions {
  /**
   * Project root used to relativise stamped source paths and jail engine writes.
   * Defaults to the dev server's `process.cwd()` (resolved in the API handler).
   * Reserved here for symmetry — pass the same value to `createDevSyncHandler`.
   */
  root?: string;
}

// --- webpack config shapes (minimal; Next hands us an untyped webpack config) ---
type LoaderUse = string | { loader?: string; options?: unknown; [k: string]: unknown };
interface RuleSetRule {
  use?: LoaderUse | LoaderUse[];
  oneOf?: RuleSetRule[];
  rules?: RuleSetRule[];
  [k: string]: unknown;
}
interface WebpackConfigish {
  module?: { rules?: RuleSetRule[] };
  plugins?: unknown[];
  [k: string]: unknown;
}

/** The subset of Next's webpack instance we use (handed to the webpack() hook). */
interface WebpackInstance {
  SourceMapDevToolPlugin?: new (opts: Record<string, unknown>) => unknown;
}

const SOURCEMAP_LOADERS = /(?:^|[\\/])(?:css-loader|postcss-loader|sass-loader)(?:[\\/]|$|\?)/;

/** Recursively collect every rule, descending into `oneOf` / nested `rules`. */
function flattenRules(rules: RuleSetRule[]): RuleSetRule[] {
  const out: RuleSetRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    out.push(rule);
    if (Array.isArray(rule.oneOf)) out.push(...flattenRules(rule.oneOf));
    if (Array.isArray(rule.rules)) out.push(...flattenRules(rule.rules));
  }
  return out;
}

/**
 * Force `sourceMap: true` on Next's CSS toolchain loaders in dev so the served
 * CSS carries a sourceMappingURL the apply engine can trace back to source —
 * Next has no `css.devSourcemap` flag, so we patch the loader options directly.
 * Mutates the config Next passed us (the documented contract of `webpack()`).
 */
export function enableCssSourceMaps(config: WebpackConfigish): WebpackConfigish {
  const rules = config.module?.rules;
  if (!Array.isArray(rules)) return config;
  for (const rule of flattenRules(rules)) {
    const uses: LoaderUse[] = Array.isArray(rule.use) ? rule.use : rule.use ? [rule.use] : [];
    for (const use of uses) {
      if (typeof use !== "object" || use === null) continue;
      const loader = use.loader;
      if (typeof loader !== "string" || !SOURCEMAP_LOADERS.test(loader)) continue;
      const prev = typeof use.options === "object" && use.options !== null ? use.options : {};
      use.options = { ...(prev as Record<string, unknown>), sourceMap: true };
    }
  }
  return config;
}

/**
 * Turning the loaders' `sourceMap` on (above) generates the map DATA, but nothing
 * writes it onto the emitted CSS: Next never sets `devtool` in dev, so webpack
 * falls back to `eval`, under which no SourceMapDevToolPlugin is installed and
 * `MiniCssExtractPlugin` emits the extracted `.css` with NO `sourceMappingURL`.
 * Forcing `config.devtool` is futile — Next snapshots it before this hook and
 * reverts any dev change (with a perf warning). So attach our OWN plugin, scoped
 * to `.css` and INLINING the map as a data URI: the apply engine reads the inline
 * `sourceMappingURL` straight off the sheet text (like the Vite path), whereas an
 * external `.map` would force it to locate Next's `.next/` build output on disk —
 * outside the write-jail's resolution, so it never loads. The JS `devtool`/HMR is
 * left untouched. `webpack` is Next's OWN instance (handed to the `webpack()`
 * callback), so we never depend on a separately-installed, version-skewed webpack.
 */
export function emitCssSourceMaps(
  config: WebpackConfigish,
  webpack: WebpackInstance | undefined,
): WebpackConfigish {
  const Plugin = webpack?.SourceMapDevToolPlugin;
  if (typeof Plugin !== "function") return config;
  const plugins = Array.isArray(config.plugins) ? config.plugins : (config.plugins = []);
  plugins.push(
    new Plugin({
      test: /\.css$/,
      // filename:false → inline the map as a base64 data URI, not an external
      // .css.map file (which the engine can't resolve for Next's .next/ output).
      filename: false,
      module: true,
      columns: true,
    }),
  );
  return config;
}

/**
 * Wrap a Next.js config to enable css-devtools-sync on the **webpack** dev server
 * (`next dev --webpack` — Turbopack has no plugin API and is unsupported).
 *
 * ```ts
 * // next.config.ts
 * import { withDevSync } from "@dev-sync/webpack";
 * export default withDevSync({ /* your config *\/ });
 * ```
 *
 * It (1) rewrites the page-origin `${MOUNT_PREFIX}/:path*` onto the internal
 * `${ENGINE_API_PATH}/:path*` handler (mount the engine there — see
 * `@dev-sync/webpack/handler`), and (2) turns on CSS dev sourcemaps. JSX source
 * stamping is a Babel plugin — add `@dev-sync/webpack/babel` to your `.babelrc`
 * (this switches Next from SWC to Babel in dev).
 */
export function withDevSync(
  nextConfig: NextConfig = {},
  _options: DevSyncNextOptions = {},
): NextConfig {
  const userRewrites = nextConfig.rewrites;
  const userWebpack = nextConfig.webpack;

  return {
    ...nextConfig,
    async rewrites() {
      const rule = { source: `${MOUNT_PREFIX}/:path*`, destination: `${ENGINE_API_PATH}/:path*` };
      const existing = typeof userRewrites === "function" ? await userRewrites() : undefined;
      // Next accepts an array (afterFiles semantics) OR a { beforeFiles, afterFiles,
      // fallback } object. Our rule must run BEFORE filesystem routes so the engine
      // POSTs never fall through to a 404 page render → always beforeFiles.
      if (Array.isArray(existing)) {
        return { beforeFiles: [rule], afterFiles: existing, fallback: [] };
      }
      if (existing && typeof existing === "object") {
        return {
          beforeFiles: [rule, ...(existing.beforeFiles ?? [])],
          afterFiles: existing.afterFiles ?? [],
          fallback: existing.fallback ?? [],
        };
      }
      return { beforeFiles: [rule], afterFiles: [], fallback: [] };
    },
    webpack(config: unknown, context: WebpackContext) {
      const out = typeof userWebpack === "function" ? userWebpack(config, context) : config;
      // `webpack()` only runs under webpack — never Turbopack — so patching here
      // is inherently scoped to the supported path. Two steps: turn the loaders'
      // sourceMap on (generates map data) AND attach a plugin that inlines it onto
      // the emitted CSS (Next's `eval` devtool otherwise drops it — see below).
      if (context?.dev) {
        enableCssSourceMaps(out as WebpackConfigish);
        emitCssSourceMaps(out as WebpackConfigish, (context as { webpack?: WebpackInstance })?.webpack);
      }
      return out;
    },
  };
}

export default withDevSync;
