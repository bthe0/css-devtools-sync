import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";
// @ts-expect-error -- no bundled types for the syntax plugin
import syntaxTypescriptImport from "@babel/plugin-syntax-typescript";
import sourceLocatorBabelPlugin, { type SourceLocatorOptions } from "./index.js";

// Pass the resolved plugin by reference, not the bare string
// "@babel/plugin-syntax-typescript": Babel resolves string plugin names relative
// to the file being transformed (the consumer's app dir), where pnpm's strict
// node_modules does not expose this package. Importing it here resolves it from
// THIS package's own dependency graph. CJS interop: `exports.default = declare(...)`
// arrives as `{ default: fn }` under some bundlers, so unwrap defensively.
const syntaxTypescript: unknown =
  typeof syntaxTypescriptImport === "function"
    ? syntaxTypescriptImport
    : (syntaxTypescriptImport as { default?: unknown }).default;

const JSX_FILE_RE = /\.[jt]sx$/;

/**
 * Vite plugin that runs the source-locator Babel plugin on .jsx/.tsx modules
 * during dev (`vite serve` only). It parses TS/JSX but leaves JSX intact, so
 * it composes with @vitejs/plugin-react running afterwards.
 */
export function sourceLocator(options: SourceLocatorOptions = {}): Plugin {
  let root = options.root ?? process.cwd();

  return {
    name: "dev-sync:source-locator",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      if (!options.root) root = config.root;
    },
    async transform(code, id) {
      const [file] = id.split("?");
      if (!file || !JSX_FILE_RE.test(file) || file.includes("/node_modules/")) return null;

      const isTsx = file.endsWith(".tsx");
      const result = await transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        // Parse only — no preset transforms. JSX is preserved for plugin-react.
        parserOpts: { plugins: isTsx ? ["typescript", "jsx"] : ["jsx"] },
        plugins: [
          ...(isTsx ? [[syntaxTypescript, { isTSX: true }]] : []),
          [sourceLocatorBabelPlugin, { root }],
        ],
      });

      if (!result?.code) return null;
      return { code: result.code, map: result.map };
    },
  };
}

export default sourceLocator;
