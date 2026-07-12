import { describe, expect, it } from "vitest";
import {
  enableCssSourceMaps,
  emitCssSourceMaps,
  MOUNT_PREFIX,
  ENGINE_API_PATH,
  withDevSync,
} from "./index.js";
import { toEnginePath } from "./handler.js";

describe("enableCssSourceMaps", () => {
  it("sets sourceMap on css/postcss/sass loaders nested under oneOf", () => {
    const config = {
      module: {
        rules: [
          {
            oneOf: [
              { use: [{ loader: "/x/next-style-loader" }, { loader: "/x/css-loader/index.js" }] },
              { use: { loader: "/x/postcss-loader/src/index.js" } },
            ],
          },
          { use: [{ loader: "/x/sass-loader/dist/cjs.js", options: { implementation: "sass" } }] },
        ],
      },
    };
    enableCssSourceMaps(config);
    const css = config.module.rules[0].oneOf![0].use as Array<{ loader: string; options?: unknown }>;
    expect((css[1].options as { sourceMap: boolean }).sourceMap).toBe(true);
    // untouched loader stays optionless
    expect(css[0].options).toBeUndefined();
    const postcss = config.module.rules[0].oneOf![1].use as unknown as {
      options: { sourceMap: boolean };
    };
    expect(postcss.options.sourceMap).toBe(true);
    // preserves existing options
    const sass = config.module.rules[1].use as Array<{ options: Record<string, unknown> }>;
    expect(sass[0].options).toEqual({ implementation: "sass", sourceMap: true });
  });

  it("is a no-op when there are no rules", () => {
    expect(enableCssSourceMaps({}).module).toBeUndefined();
  });
});

describe("emitCssSourceMaps", () => {
  // A stand-in for Next's own webpack instance handed to the webpack() hook.
  class FakeSourceMapDevToolPlugin {
    constructor(public opts: Record<string, unknown>) {}
  }
  const fakeWebpack = { SourceMapDevToolPlugin: FakeSourceMapDevToolPlugin };

  it("attaches a css-scoped, INLINE SourceMapDevToolPlugin from Next's webpack instance", () => {
    const config: { plugins?: unknown[] } = {};
    emitCssSourceMaps(config, fakeWebpack);
    expect(config.plugins).toHaveLength(1);
    const plugin = config.plugins![0] as FakeSourceMapDevToolPlugin;
    expect(plugin).toBeInstanceOf(FakeSourceMapDevToolPlugin);
    expect((plugin.opts.test as RegExp).source).toBe("\\.css$");
    // filename:false is what inlines the map as a data URI (engine reads it off
    // the sheet text) rather than emitting an external .css.map file.
    expect(plugin.opts.filename).toBe(false);
  });

  it("appends to existing plugins without clobbering them", () => {
    const existing = { name: "user-plugin" };
    const config: { plugins?: unknown[] } = { plugins: [existing] };
    emitCssSourceMaps(config, fakeWebpack);
    expect(config.plugins).toHaveLength(2);
    expect(config.plugins![0]).toBe(existing);
  });

  it("is a safe no-op when the webpack instance has no plugin (never throws)", () => {
    const config: { plugins?: unknown[] } = {};
    expect(() => emitCssSourceMaps(config, undefined)).not.toThrow();
    expect(() => emitCssSourceMaps(config, {})).not.toThrow();
    expect(config.plugins).toBeUndefined();
  });

  it("withDevSync wires it in dev (plugin added) but not in prod", () => {
    const devBuilt: { module: { rules: unknown[] }; plugins?: unknown[] } = {
      module: { rules: [{ use: [{ loader: "css-loader" }] }] },
    };
    withDevSync().webpack!(devBuilt, { dev: true, webpack: fakeWebpack } as never);
    expect(devBuilt.plugins).toHaveLength(1);
    expect(devBuilt.plugins![0]).toBeInstanceOf(FakeSourceMapDevToolPlugin);

    const prodBuilt: { module: { rules: unknown[] }; plugins?: unknown[] } = {
      module: { rules: [{ use: [{ loader: "css-loader" }] }] },
    };
    withDevSync().webpack!(prodBuilt, { dev: false, webpack: fakeWebpack } as never);
    expect(prodBuilt.plugins).toBeUndefined();
  });
});

describe("withDevSync rewrites", () => {
  it("puts the engine rewrite in beforeFiles so it wins over page routes", async () => {
    const rewrites = await withDevSync().rewrites!();
    expect(Array.isArray(rewrites)).toBe(false);
    const obj = rewrites as { beforeFiles: Array<{ source: string; destination: string }> };
    expect(obj.beforeFiles[0]).toEqual({
      source: `${MOUNT_PREFIX}/:path*`,
      destination: `${ENGINE_API_PATH}/:path*`,
    });
  });

  it("keeps a user's array rewrites as afterFiles", async () => {
    const user = { rewrites: async () => [{ source: "/a", destination: "/b" }] };
    const merged = (await withDevSync(user).rewrites!()) as {
      beforeFiles: unknown[];
      afterFiles: Array<{ source: string }>;
    };
    expect(merged.beforeFiles).toHaveLength(1);
    expect(merged.afterFiles[0]).toEqual({ source: "/a", destination: "/b" });
  });
});

describe("withDevSync webpack", () => {
  it("patches CSS sourcemaps only in dev and calls the user's webpack first", () => {
    let userCalled = false;
    const cfg = { rules: [] as unknown[] };
    const config = {
      webpack: (c: unknown) => {
        userCalled = true;
        return c;
      },
    };
    const wrapped = withDevSync(config);
    const built = { module: { rules: [{ use: [{ loader: "css-loader" }] }] } };
    wrapped.webpack!(built, { dev: true } as never);
    expect(userCalled).toBe(true);
    expect(
      (built.module.rules[0].use[0] as unknown as { options: { sourceMap: boolean } }).options
        .sourceMap,
    ).toBe(true);

    const prod = { module: { rules: [{ use: [{ loader: "css-loader" }] }] } };
    withDevSync().webpack!(prod, { dev: false } as never);
    expect((prod.module.rules[0].use[0] as { options?: unknown }).options).toBeUndefined();
    void cfg;
  });
});

describe("toEnginePath", () => {
  it("strips the api mount prefix and the page-origin prefix", () => {
    expect(toEnginePath("/api/__dev-sync/apply")).toBe("/apply");
    expect(toEnginePath("/api/__dev-sync/journal?limit=5")).toBe("/journal?limit=5");
    expect(toEnginePath("/__dev-sync/undo")).toBe("/undo");
    expect(toEnginePath("/api/__dev-sync")).toBe("/");
  });
});
