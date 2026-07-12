// init-detect.test.ts — `css-sync init` stack detection.
//
// detectStack reads a target repo (package.json + vite.config.*) and reports
// what the init command can wire up: the bundler (Vite-only in v1), the
// vite config path + source, which css-in-js libs are present, whether
// Tailwind is present (warn-and-skip in v1), and whether an injectable
// @vitejs/plugin-react (babel, not swc) is configured.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStack } from "../src/init/detect.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-detect-")));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const PKG = (deps: Record<string, string>, devDeps: Record<string, string> = {}) =>
  JSON.stringify({ name: "target", dependencies: deps, devDependencies: devDeps }, null, 2) + "\n";

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
`;

describe("detectStack — bundler", () => {
  it("reports vite when a vite config exists and vite is a devDependency", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.bundler).toBe("vite");
    expect(r.configPath).toBe(path.join(root, "vite.config.ts"));
    expect(r.configSource).toContain("defineConfig");
  });

  it("finds the config regardless of extension (.mts)", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.mts": VITE_CONFIG,
    });
    expect(detectStack(root).configPath).toBe(path.join(root, "vite.config.mts"));
  });

  it("reports unknown bundler when there is no vite config and no vite dep", () => {
    const root = makeRepo({ "package.json": PKG({ webpack: "^5.0.0" }) });
    const r = detectStack(root);
    expect(r.bundler).toBe("unknown");
    expect(r.configPath).toBeNull();
    expect(r.configSource).toBeNull();
  });

  it("reports vite bundler but null configPath when the dep exists but no config file", () => {
    const root = makeRepo({ "package.json": PKG({}, { vite: "^5.0.0" }) });
    const r = detectStack(root);
    expect(r.bundler).toBe("vite");
    expect(r.configPath).toBeNull();
  });

  // A `vite` dep is NOT proof of a Vite app — Vitest and Vite-based frameworks
  // (Next, Astro) pull vite transitively. Without a vite.config on disk, those
  // signals must disqualify the dep-only fallback so init reports no-vite
  // instead of telling a Next user to "create a vite.config".
  it("does NOT report vite for a Next app whose vite dep comes from vitest", () => {
    const root = makeRepo({
      "package.json": PKG({ next: "16.0.0", react: "^19.0.0" }, { vite: "^5.4.0", vitest: "^3.0.0" }),
      "next.config.ts": `export default {};\n`,
      "vitest.config.ts": `import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n`,
    });
    const r = detectStack(root);
    expect(r.bundler).toBe("unknown");
    expect(r.configPath).toBeNull(); // vitest.config.ts is not a vite bundler config
  });

  it("does NOT report vite when a vite dep is explained solely by vitest (no config)", () => {
    const root = makeRepo({ "package.json": PKG({}, { vite: "^5.4.0", vitest: "^3.0.0" }) });
    expect(detectStack(root).bundler).toBe("unknown");
  });

  it("still reports vite when a real vite.config exists alongside next/vitest", () => {
    const root = makeRepo({
      "package.json": PKG({ next: "16.0.0" }, { vite: "^5.4.0", vitest: "^3.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.bundler).toBe("vite"); // an on-disk vite config is definitive
    expect(r.configPath).toBe(path.join(root, "vite.config.ts"));
  });
});

describe("detectStack — css-in-js + tailwind + react plugin", () => {
  it("detects styled-components and emotion from dependencies", () => {
    const root = makeRepo({
      "package.json": PKG({ "styled-components": "^6.0.0", "@emotion/styled": "^11.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.cssInJs).toEqual(expect.arrayContaining(["styled-components", "emotion"]));
    expect(r.cssInJs).toHaveLength(2);
  });

  it("treats @emotion/react as emotion too, and de-dupes", () => {
    const root = makeRepo({
      "package.json": PKG({ "@emotion/react": "^11.0.0", "@emotion/styled": "^11.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    expect(detectStack(root).cssInJs).toEqual(["emotion"]);
  });

  it("flags tailwind when tailwindcss is present", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0", tailwindcss: "^3.4.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    expect(detectStack(root).tailwind).toBe(true);
  });

  it("hasReactPlugin true for @vitejs/plugin-react, false for the swc variant", () => {
    const babel = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    expect(detectStack(babel).hasReactPlugin).toBe(true);

    const swc = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0", "@vitejs/plugin-react-swc": "^3.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    expect(detectStack(swc).hasReactPlugin).toBe(false);
  });

  it("reports the full sorted dependency name set (deps + devDeps)", () => {
    const root = makeRepo({
      "package.json": PKG({ "styled-components": "^6.0.0" }, { vite: "^5.0.0", tailwindcss: "^3.4.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    expect(detectStack(root).dependencies).toEqual(["styled-components", "tailwindcss", "vite"]);
  });

  it("defaults everything off for a bare repo with no css-in-js / tailwind / react", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.cssInJs).toEqual([]);
    expect(r.tailwind).toBe(false);
    expect(r.hasReactPlugin).toBe(false);
  });
});

describe("detectStack — meta-framework detection", () => {
  // css-sync init v1 targets plain Vite + React. Meta-frameworks own their own
  // build/config (and mostly aren't React), so they're detected and skipped
  // rather than mis-onboarded. A React framework with its own vite config
  // (Remix, Next) is still a framework here — v1 doesn't auto-edit those.
  it.each([
    ["next", { next: "16.0.0" }, "Next.js"],
    ["nuxt", { nuxt: "^3.0.0" }, "Nuxt"],
    ["astro", { astro: "^4.0.0" }, "Astro"],
    ["@sveltejs/kit", { "@sveltejs/kit": "^2.0.0" }, "SvelteKit"],
    ["@remix-run/dev", { "@remix-run/dev": "^2.0.0" }, "Remix"],
    ["@builder.io/qwik", { "@builder.io/qwik": "^1.0.0" }, "Qwik"],
    ["@solidjs/start", { "@solidjs/start": "^1.0.0" }, "SolidStart"],
    ["vue (bare)", { vue: "^3.0.0" }, "Vue"],
  ])("flags %s as framework %s", (_label, dep, expected) => {
    const root = makeRepo({ "package.json": PKG(dep, { vite: "^5.0.0" }) });
    expect(detectStack(root).framework).toBe(expected);
  });

  it("a framework marker suppresses the vite-dep bundler fallback (no vite.config)", () => {
    const root = makeRepo({ "package.json": PKG({ nuxt: "^3.0.0" }, { vite: "^5.0.0" }) });
    expect(detectStack(root).bundler).toBe("unknown");
  });

  it("still finds the vite.config for a framework that ships one (SvelteKit)", () => {
    const root = makeRepo({
      "package.json": PKG({ "@sveltejs/kit": "^2.0.0", svelte: "^5.0.0" }, { vite: "^5.0.0" }),
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.framework).toBe("SvelteKit");
    expect(r.configPath).toBe(path.join(root, "vite.config.ts")); // config still read
  });

  it("a plain React + Vite app is NOT a framework", () => {
    const root = makeRepo({
      "package.json": PKG(
        { react: "^19.0.0", "react-dom": "^19.0.0" },
        { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0" },
      ),
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.framework).toBeNull();
    expect(r.bundler).toBe("vite");
  });
});

describe("detectStack — malformed / missing package.json", () => {
  it("tolerates a missing package.json (bundler still inferred from the config file)", () => {
    const root = makeRepo({ "vite.config.ts": VITE_CONFIG });
    const r = detectStack(root);
    expect(r.bundler).toBe("vite"); // config present ⇒ vite even without a package.json
    expect(r.cssInJs).toEqual([]);
    expect(r.tailwind).toBe(false);
  });

  it("tolerates malformed package.json JSON without throwing", () => {
    const root = makeRepo({
      "package.json": "{ not valid json",
      "vite.config.ts": VITE_CONFIG,
    });
    const r = detectStack(root);
    expect(r.bundler).toBe("vite");
    expect(r.cssInJs).toEqual([]);
  });
});
