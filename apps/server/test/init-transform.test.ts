// init-transform.test.ts — `css-sync init` AST edits on a vite config.
//
// transformViteConfig performs recast-preserving edits: set css.devSourcemap,
// inject emotion / styled-components babel plugins into the react() block, and
// prepend a sourceLocator() plugin (+ its import). Contract:
//   - idempotent: re-running produces byte-identical output (no double-add).
//   - fail-closed: never emit source that doesn't re-parse; when a sub-edit
//     can't be applied safely it's a warning, not a corruption.
//   - all-or-nothing corruption guard: if the top-level config object can't be
//     located, throw SkipChangeError rather than guess.
import { parse as babelParse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { transformViteConfig, type InitTransformPlan } from "../src/init/transform.js";
import { SkipChangeError } from "../src/errors.js";

/** Re-parse guard used across tests: output must always be valid TS/JSX module. */
function assertParses(source: string): void {
  expect(() =>
    babelParse(source, { sourceType: "module", plugins: ["jsx", "typescript"], tokens: true }),
  ).not.toThrow();
}

const PLAN = (over: Partial<InitTransformPlan> = {}): InitTransformPlan => ({
  devSourcemap: true,
  emotion: false,
  styledComponents: false,
  sourceLocator: false,
  ...over,
});

const BARE = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`;

describe("transformViteConfig — css.devSourcemap", () => {
  it("adds a css block with devSourcemap:true when css is absent", () => {
    const { source, changed } = transformViteConfig(BARE, PLAN());
    expect(changed).toBe(true);
    expect(source).toMatch(/devSourcemap:\s*true/);
    assertParses(source);
  });

  it("adds devSourcemap to an existing css block without clobbering siblings", () => {
    const input = `import { defineConfig } from "vite";
export default defineConfig({
  css: { modules: { localsConvention: "camelCase" } },
});
`;
    const { source } = transformViteConfig(input, PLAN());
    expect(source).toMatch(/devSourcemap:\s*true/);
    expect(source).toContain("localsConvention"); // sibling preserved
    assertParses(source);
  });

  it("is idempotent when devSourcemap:true already present (no change)", () => {
    const input = `import { defineConfig } from "vite";
export default defineConfig({
  css: { devSourcemap: true },
});
`;
    const { source, changed } = transformViteConfig(input, PLAN());
    expect(changed).toBe(false);
    expect(source).toBe(input);
  });

  it("works with a bare object-literal default export (no defineConfig wrapper)", () => {
    const input = `export default {
  plugins: [],
};
`;
    const { source } = transformViteConfig(input, PLAN());
    expect(source).toMatch(/devSourcemap:\s*true/);
    assertParses(source);
  });
});

describe("transformViteConfig — babel plugin injection", () => {
  it("injects @emotion/babel-plugin into react()'s babel.plugins", () => {
    const { source } = transformViteConfig(BARE, PLAN({ emotion: true }));
    expect(source).toContain("@emotion/babel-plugin");
    expect(source).toMatch(/labelFormat/);
    assertParses(source);
  });

  it("injects babel-plugin-styled-components with displayName", () => {
    const { source } = transformViteConfig(BARE, PLAN({ styledComponents: true }));
    expect(source).toContain("babel-plugin-styled-components");
    expect(source).toMatch(/displayName:\s*true/);
    assertParses(source);
  });

  it("injects both when both requested", () => {
    const { source } = transformViteConfig(BARE, PLAN({ emotion: true, styledComponents: true }));
    expect(source).toContain("@emotion/babel-plugin");
    expect(source).toContain("babel-plugin-styled-components");
    assertParses(source);
  });

  it("creates a babel block when react() has no arguments", () => {
    const { source } = transformViteConfig(BARE, PLAN({ styledComponents: true }));
    expect(source).toMatch(/babel:\s*{/);
    assertParses(source);
  });

  it("preserves an existing react() argument object and its keys", () => {
    const input = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react({ jsxImportSource: "@emotion/react" })],
});
`;
    const { source } = transformViteConfig(input, PLAN({ emotion: true }));
    expect(source).toContain("jsxImportSource"); // existing key kept
    expect(source).toContain("@emotion/babel-plugin");
    assertParses(source);
  });

  it("is idempotent — does not double-inject an already-present plugin", () => {
    const once = transformViteConfig(BARE, PLAN({ emotion: true, styledComponents: true })).source;
    const twice = transformViteConfig(once, PLAN({ emotion: true, styledComponents: true })).source;
    expect(twice).toBe(once);
    // exactly one occurrence of each package name
    expect(once.match(/@emotion\/babel-plugin/g)).toHaveLength(1);
    expect(once.match(/babel-plugin-styled-components/g)).toHaveLength(1);
  });

  it("warns (does not throw) when css-in-js requested but no react() call exists", () => {
    const input = `import { defineConfig } from "vite";
export default defineConfig({ plugins: [] });
`;
    const { source, warnings } = transformViteConfig(input, PLAN({ emotion: true }));
    expect(warnings.some((w) => /react\(\)/.test(w))).toBe(true);
    expect(source).toMatch(/devSourcemap:\s*true/); // css edit still applied
    assertParses(source);
  });
});

describe("transformViteConfig — sourceLocator plugin", () => {
  it("prepends sourceLocator() and adds its import", () => {
    const { source } = transformViteConfig(BARE, PLAN({ sourceLocator: true }));
    expect(source).toContain("@css-sync/babel-plugin-source-locator/vite");
    expect(source).toMatch(/sourceLocator\(\)/);
    // prepended before react() in the plugins array
    expect(source.indexOf("sourceLocator()")).toBeLessThan(source.indexOf("react("));
    assertParses(source);
  });

  it("is idempotent — no duplicate import or plugin entry", () => {
    const once = transformViteConfig(BARE, PLAN({ sourceLocator: true })).source;
    const twice = transformViteConfig(once, PLAN({ sourceLocator: true })).source;
    expect(twice).toBe(once);
    expect(once.match(/babel-plugin-source-locator\/vite/g)).toHaveLength(1);
    expect(once.match(/sourceLocator\(\)/g)).toHaveLength(1);
  });
});

describe("transformViteConfig — fail-closed corruption guard", () => {
  it("throws SkipChangeError when the default export is not a config object", () => {
    const input = `import { defineConfig } from "vite";
export default defineConfig(makeConfig());
`;
    expect(() => transformViteConfig(input, PLAN())).toThrow(SkipChangeError);
  });

  it("throws SkipChangeError when there is no default export at all", () => {
    const input = `import { defineConfig } from "vite";
const config = defineConfig({});
`;
    expect(() => transformViteConfig(input, PLAN())).toThrow(SkipChangeError);
  });

  it("throws SkipChangeError when css is present but not an object literal", () => {
    const input = `import { defineConfig } from "vite";
export default defineConfig({ css: someCssConfig });
`;
    expect(() => transformViteConfig(input, PLAN())).toThrow(SkipChangeError);
  });

  it("full plan on a realistic config parses and applies everything", () => {
    const { source } = transformViteConfig(
      BARE,
      PLAN({ emotion: true, styledComponents: true, sourceLocator: true }),
    );
    expect(source).toMatch(/devSourcemap:\s*true/);
    expect(source).toContain("@emotion/babel-plugin");
    expect(source).toContain("babel-plugin-styled-components");
    expect(source).toContain("sourceLocator()");
    assertParses(source);
  });
});
