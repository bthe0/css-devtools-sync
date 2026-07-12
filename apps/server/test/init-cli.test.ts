// init-cli.test.ts — `css-sync init` CLI seam (render + confirm-gated write).
//
// The bin's interactive shell (readline/console) is thin wiring; the testable
// core is renderPlan (InitPlan -> printable text) and runInit (plan -> gated
// write via injected IO). The safety-critical guarantee under test: a config
// file is written ONLY on an explicit confirm (or --yes), and NEVER for a
// non-"ready" status.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPlan, runInit, type InitIO } from "../src/cli.js";
import { planInit } from "../src/init/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-cli-")));
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

function readyRepo(): string {
  return makeRepo({ "package.json": PKG({}, { vite: "^5.0.0" }), "vite.config.ts": VITE });
}

function io(workspaceRoot: string, over: Partial<InitIO> = {}): InitIO & { logs: string[]; writes: [string, string, string][] } {
  const logs: string[] = [];
  const writes: [string, string, string][] = [];
  return {
    workspaceRoot,
    logs,
    writes,
    log: (m) => logs.push(m),
    confirm: async () => true,
    write: (root, target, content) => {
      writes.push([root, target, content]);
    },
    ...over,
  };
}

describe("runInit — confirm-gated write", () => {
  it("writes the transformed config when confirmed", async () => {
    const root = readyRepo();
    const the = io(root);
    const out = await runInit(the);
    expect(out.status).toBe("ready");
    expect(out.written).toBe(true);
    expect(the.writes).toHaveLength(1);
    const [, target, content] = the.writes[0]!;
    expect(content).toMatch(/devSourcemap:\s*true/);
    // the write is jailed-through-the-injected-writer with the config path
    expect(path.resolve(root, target)).toBe(path.join(root, "vite.config.ts"));
  });

  it("does NOT write when the user declines", async () => {
    const root = readyRepo();
    const the = io(root, { confirm: async () => false });
    const out = await runInit(the);
    expect(out.written).toBe(false);
    expect(the.writes).toHaveLength(0);
    // file on disk is untouched
    expect(fs.readFileSync(path.join(root, "vite.config.ts"), "utf8")).toBe(VITE);
  });

  it("--yes skips the prompt and writes without calling confirm", async () => {
    const root = readyRepo();
    const confirm = vi.fn(async () => true);
    const the = io(root, { assumeYes: true, confirm });
    const out = await runInit(the);
    expect(out.written).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("runInit — never writes for a non-ready status", () => {
  it("no-vite → no confirm, no write", async () => {
    const root = makeRepo({ "package.json": PKG({ webpack: "^5.0.0" }) });
    const confirm = vi.fn(async () => true);
    const the = io(root, { confirm });
    const out = await runInit(the);
    expect(out.status).toBe("no-vite");
    expect(out.written).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(the.writes).toHaveLength(0);
  });

  it("up-to-date → no write", async () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.ts": `import { defineConfig } from "vite";
export default defineConfig({ css: { devSourcemap: true } });
`,
    });
    const out = await runInit(io(root));
    expect(out.status).toBe("up-to-date");
    expect(out.written).toBe(false);
  });

  it("manual → no write, message logged", async () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0" }),
      "vite.config.ts": `export default makeConfig();\n`,
    });
    const the = io(root);
    const out = await runInit(the);
    expect(out.status).toBe("manual");
    expect(out.written).toBe(false);
    expect(the.logs.join("\n")).toMatch(/manual|couldn't safely edit/i);
  });
});

describe("renderPlan — human output", () => {
  it("ready: shows the diff and a confirm-oriented summary", () => {
    const root = readyRepo();
    const text = renderPlan(planInit(root));
    expect(text).toContain("vite.config.ts");
    expect(text).toContain("devSourcemap");
  });

  it("lists required dev deps with an install hint", () => {
    const root = makeRepo({
      "package.json": PKG({ "@emotion/react": "^11.0.0" }, { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0" }),
      "vite.config.ts": VITE,
    });
    const text = renderPlan(planInit(root));
    expect(text).toMatch(/@emotion\/babel-plugin/);
    expect(text).toMatch(/install/i);
  });

  it("surfaces the tailwind warn-and-skip note", () => {
    const root = makeRepo({
      "package.json": PKG({}, { vite: "^5.0.0", tailwindcss: "^3.4.0" }),
      "vite.config.ts": VITE,
    });
    const text = renderPlan(planInit(root));
    expect(text).toMatch(/tailwind/i);
  });
});
