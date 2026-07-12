// init-plan.test.ts — `css-sync init` orchestrator (detect → plan → diff).
//
// planInit is pure/read-only: it reads the target repo, decides what init
// should do, and returns a diff to preview — it writes NOTHING (the CLI owns
// the confirm+write step). Key rules under test:
//   - Vite-only in v1; non-Vite / config-less repos get a clear early status.
//   - Plugin injection is GATED on the plugin package being installed — never
//     wire a config to a package the repo hasn't got (that breaks vite dev).
//   - Tailwind is warn-and-skip; swc react plugin can't take babel plugins.
//   - Unrecognized config shape → status "manual" (SkipChangeError message).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planInit } from "../src/init/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-plan-")));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const PKG = (deps: Record<string, string> = {}, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: "t", dependencies: deps, devDependencies: dev }, null, 2) + "\n";

const VITE = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
`;

describe("planInit — unsupported / edge statuses", () => {
  it("non-Vite repo → status no-vite", () => {
    const root = makeRepo({ "package.json": PKG({ webpack: "^5.0.0" }) });
    const plan = planInit(root);
    expect(plan.status).toBe("no-vite");
    expect(plan.newSource).toBeNull();
  });

  it("vite dep but no config file → status no-config", () => {
    const root = makeRepo({ "package.json": PKG({}, { vite: "^5.0.0" }) });
    expect(planInit(root).status).toBe("no-config");
  });

  it("unrecognized config shape → status manual with a human message", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.ts": `import { defineConfig } from "vite";
export default defineConfig(makeConfig());
`,
    });
    const plan = planInit(root);
    expect(plan.status).toBe("manual");
    expect(plan.message).toMatch(/manual|isn't a plain config object/i);
    expect(plan.newSource).toBeNull();
  });

  it("config already fully configured → status up-to-date", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.ts": `import { defineConfig } from "vite";
export default defineConfig({ css: { devSourcemap: true } });
`,
    });
    expect(planInit(root).status).toBe("up-to-date");
  });
});

describe("planInit — meta-framework skip", () => {
  const FRAMEWORK_VITE = `import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [sveltekit()] });
`;

  it("framework with its own vite.config → status framework, never a ready diff", () => {
    const root = makeRepo({
      "package.json": PKG({ "@sveltejs/kit": "^2.0.0", svelte: "^5.0.0" }, { vite: "^5.0.0" }),
      "vite.config.ts": FRAMEWORK_VITE,
    });
    const plan = planInit(root);
    expect(plan.status).toBe("framework");
    expect(plan.newSource).toBeNull();
    expect(plan.diff).toBe("");
    expect(plan.message).toMatch(/sveltekit/i);
    // the config on disk is never proposed for editing
    expect(fs.readFileSync(path.join(root, "vite.config.ts"), "utf8")).toBe(FRAMEWORK_VITE);
  });

  it("framework without a vite.config (Nuxt) → status framework, not no-config", () => {
    const root = makeRepo({ "package.json": PKG({ nuxt: "^3.0.0" }, { vite: "^5.0.0" }) });
    const plan = planInit(root);
    expect(plan.status).toBe("framework");
    expect(plan.message).toMatch(/nuxt/i);
  });
});

describe("planInit — plain CSS baseline", () => {
  it("plain repo → status ready, diff enables css.devSourcemap, no required deps", () => {
    const root = makeRepo({ "package.json": PKG({}, { vite: "^5.0.0" }), "vite.config.ts": VITE });
    const plan = planInit(root);
    expect(plan.status).toBe("ready");
    expect(plan.newSource).toMatch(/devSourcemap:\s*true/);
    expect(plan.diff).toContain("+");
    expect(plan.diff).toContain("vite.config.ts");
    expect(plan.requiredDevDeps).toEqual([]);
  });
});

describe("planInit — css-in-js plugin gating", () => {
  it("emotion + @emotion/babel-plugin installed → injects the plugin", () => {
    const root = makeRepo({
      "package.json": PKG(
        { "@emotion/react": "^11.0.0" },
        { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0", "@emotion/babel-plugin": "^11.0.0" },
      ),
      "vite.config.ts": VITE,
    });
    const plan = planInit(root);
    expect(plan.status).toBe("ready");
    expect(plan.newSource).toContain("@emotion/babel-plugin");
    expect(plan.requiredDevDeps).toEqual([]);
  });

  it("emotion but babel plugin NOT installed → css only, plugin listed as a required dep", () => {
    const root = makeRepo({
      "package.json": PKG({ "@emotion/react": "^11.0.0" }, { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0" }),
      "vite.config.ts": VITE,
    });
    const plan = planInit(root);
    expect(plan.status).toBe("ready");
    expect(plan.newSource).not.toContain("@emotion/babel-plugin"); // not wired until installed
    expect(plan.newSource).toMatch(/devSourcemap:\s*true/); // baseline still applied
    expect(plan.requiredDevDeps.map((d) => d.pkg)).toContain("@emotion/babel-plugin");
  });

  it("styled-components installed but react plugin is swc → warns, does not inject", () => {
    const root = makeRepo({
      "package.json": PKG(
        { "styled-components": "^6.0.0" },
        { vite: "^5.0.0", "@vitejs/plugin-react-swc": "^3.0.0", "babel-plugin-styled-components": "^2.0.0" },
      ),
      "vite.config.ts": VITE,
    });
    const plan = planInit(root);
    expect(plan.newSource).not.toContain("babel-plugin-styled-components");
    expect(plan.warnings.some((w) => /swc|@vitejs\/plugin-react\b/.test(w))).toBe(true);
  });
});

describe("planInit — tailwind warn-and-skip", () => {
  it("tailwind present → sets a tailwindNote, still produces the css baseline", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0", tailwindcss: "^3.4.0" }),
      "vite.config.ts": VITE,
    });
    const plan = planInit(root);
    expect(plan.tailwindNote).toMatch(/tailwind/i);
    expect(plan.status).toBe("ready");
    expect(plan.newSource).toMatch(/devSourcemap:\s*true/);
  });
});
