import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CapturePayloadInput, StyleSheetRef } from "@dev-sync/contract";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

/**
 * End-to-end (/apply) for the CSS Modules reverse-map channel: a served hashed
 * module selector (`._title_1ah9a_9`) carries no usable range, so the client
 * ships the framework's own `{local -> hash}` export map as `cssModuleMap`. The
 * apply spine reverses the hash to the source selector + owning file and routes
 * by extension — SFC `<style module>` block vs plain `*.module.css`. Fail-closed:
 * without the map the change must skip-with-reason, never mis-write.
 */

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// The served sheet is the compiled module output; its URL never resolves to a
// real source file — that's the whole point (the reverse map does the routing).
const HASHED_SHEET: StyleSheetRef = {
  id: "sheet-mod",
  sourceURL: "http://localhost:5173/assets/index-abc123.css",
  origin: "regular",
};

function makeCfg(workspaceRoot: string): Config {
  return {
    workspaceRoot,
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined,
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    journalDir: path.join(workspaceRoot, ".dev-sync-journal"),
  };
}

/** Fresh temp workspace with one source file at `relFile`. */
function makeWorkspace(relFile: string, content: string): { root: string; abs: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-module-")));
  tmpDirs.push(root);
  const abs = path.join(root, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return { root, abs };
}

async function makeApp(root: string): Promise<FastifyInstance> {
  const app = await buildServer(makeCfg(root));
  apps.push(app);
  return app;
}

interface ApplyBody {
  applied: { mode: string; file: string }[];
  skipped: { reason: string }[];
}

describe("CSS Modules reverse-map — /apply routing", () => {
  it("reverses a hashed selector into a Vue <style module> block and edits the source", async () => {
    const rel = "src/components/ModuleCard.vue";
    const sfc = `<template>\n  <div :class="$style.title">hi</div>\n</template>\n\n<style module>\n.title {\n  color: red;\n}\n</style>\n`;
    const { root, abs } = makeWorkspace(rel, sfc);
    const app = await makeApp(root);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5173/",
      applyMode: "commit",
      cssModuleMap: {
        _title_1ah9a_9: { local: "title", file: rel },
      },
      changes: [
        {
          op: "modify",
          styleSheet: HASHED_SHEET,
          selector: "._title_1ah9a_9",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
      ],
    };

    const res = await app.inject({ method: "POST", url: "/apply", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApplyBody;
    expect(body.skipped).toHaveLength(0);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]?.mode).toBe("postcss");
    expect(body.applied[0]?.file).toBe(rel);

    const written = fs.readFileSync(abs, "utf8");
    expect(written).toContain("color: blue;");
    expect(written).not.toContain("color: red;");
    // Everything outside the <style module> block is byte-identical.
    expect(written).toContain(`<div :class="$style.title">hi</div>`);
  });

  it("reverses a hashed selector into a plain *.module.css file and edits it", async () => {
    const rel = "src/Button.module.css";
    const css = `.btn {\n  cursor: default;\n}\n`;
    const { root, abs } = makeWorkspace(rel, css);
    const app = await makeApp(root);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5173/",
      applyMode: "commit",
      cssModuleMap: {
        _btn_z9x8_1: { local: "btn", file: rel },
      },
      changes: [
        {
          op: "modify",
          styleSheet: HASHED_SHEET,
          selector: "._btn_z9x8_1",
          property: "cursor",
          oldValue: "default",
          newValue: "pointer",
        },
      ],
    };

    const res = await app.inject({ method: "POST", url: "/apply", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApplyBody;
    expect(body.skipped).toHaveLength(0);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]?.mode).toBe("postcss");
    expect(body.applied[0]?.file).toBe(rel);

    expect(fs.readFileSync(abs, "utf8")).toContain("cursor: pointer;");
  });

  it("fail-closed: without a cssModuleMap the hashed selector skips-with-reason (no write)", async () => {
    const rel = "src/components/ModuleCard.vue";
    const sfc = `<template>\n  <div :class="$style.title">hi</div>\n</template>\n\n<style module>\n.title {\n  color: red;\n}\n</style>\n`;
    const { root, abs } = makeWorkspace(rel, sfc);
    const app = await makeApp(root);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5173/",
      applyMode: "commit",
      // no cssModuleMap
      changes: [
        {
          op: "modify",
          styleSheet: HASHED_SHEET,
          selector: "._title_1ah9a_9",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
      ],
    };

    const res = await app.inject({ method: "POST", url: "/apply", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApplyBody;
    expect(body.applied).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    // Source untouched.
    expect(fs.readFileSync(abs, "utf8")).toContain("color: red;");
  });

  it("fail-closed: a hashed selector spanning two source files is refused (ambiguous)", async () => {
    const rel = "src/components/ModuleCard.vue";
    const sfc = `<template>\n  <div :class="$style.card">hi</div>\n</template>\n\n<style module>\n.card .btn {\n  color: red;\n}\n</style>\n`;
    const { root, abs } = makeWorkspace(rel, sfc);
    const app = await makeApp(root);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5173/",
      applyMode: "commit",
      cssModuleMap: {
        _card_1ah9a_2: { local: "card", file: rel },
        _btn_z9x8_1: { local: "btn", file: "src/Button.module.css" },
      },
      changes: [
        {
          op: "modify",
          styleSheet: HASHED_SHEET,
          selector: "._card_1ah9a_2 ._btn_z9x8_1",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
      ],
    };

    const res = await app.inject({ method: "POST", url: "/apply", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApplyBody;
    expect(body.applied).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(fs.readFileSync(abs, "utf8")).toContain("color: red;");
  });
});
