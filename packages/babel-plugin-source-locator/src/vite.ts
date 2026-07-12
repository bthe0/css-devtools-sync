import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";
import sourceLocatorBabelPlugin, { type SourceLocatorOptions } from "./index.js";

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
          ...(isTsx ? [["@babel/plugin-syntax-typescript", { isTSX: true }]] : []),
          [sourceLocatorBabelPlugin, { root }],
        ],
      });

      if (!result?.code) return null;
      return { code: result.code, map: result.map };
    },
  };
}

export default sourceLocator;
