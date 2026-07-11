import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CapturePayload, PromoteInlineStyleChange } from "@css-sync/contract";
import { CaptureChangeSchema } from "@css-sync/contract";
import type { Config } from "../src/config.js";
import { applyInlinePromote } from "../src/apply-inline-promote.js";
import { SkipChangeError } from "../src/errors.js";
import { buildServer } from "../src/server.js";

/**
 * Inline-style promote tier: an element.style edit becomes a generated
 * `csync-*` class on the element + a matching rule in the overrides stylesheet.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../test-app/src/components");

const STATIC_BLOCK = "StaticBlock.tsx";
const STRONG_LINE = 25; // <strong style={{ color: "#f3f4f8", ... }}> — has NO className

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Fresh workspace: StaticBlock.tsx fixture + an overrides stylesheet. */
function makeWorkspace(overridesContent: string | null = ""): {
  root: string;
  srcDir: string;
  componentsDir: string;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-promote-")));
  tmpDirs.push(root);
  const srcDir = path.join(root, "src");
  const componentsDir = path.join(srcDir, "components");
  fs.mkdirSync(componentsDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, STATIC_BLOCK), path.join(componentsDir, STATIC_BLOCK));
  if (overridesContent !== null) {
    fs.writeFileSync(path.join(srcDir, "index.css"), overridesContent, "utf8");
  }
  return { root, srcDir, componentsDir };
}

function makeCfg(workspaceRoot: string): Config {
  return {
    workspaceRoot,
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined,
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
  };
}

function readTsx(componentsDir: string): string {
  return fs.readFileSync(path.join(componentsDir, STATIC_BLOCK), "utf8");
}
function readOverrides(srcDir: string): string {
  return fs.readFileSync(path.join(srcDir, "index.css"), "utf8");
}

function promoteChange(
  className: string,
  declarations: PromoteInlineStyleChange["declarations"],
): PromoteInlineStyleChange {
  return {
    op: "promote-inline-style",
    className,
    declarations,
    element: {
      tagName: "strong",
      classList: [],
      dataSourceFile: `src/components/${STATIC_BLOCK}`,
      dataSourceLine: STRONG_LINE,
      dataSourceComponent: "StaticBlock",
    },
  };
}

describe("applyInlinePromote — happy path", () => {
  it("adds the generated class to the element and creates the overrides rule", () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const cfg = makeCfg(root);

    const res = applyInlinePromote(
      promoteChange("csync-1a2b", [{ property: "color", value: "#ff0000" }]),
      cfg,
    );

    expect(res.file).toBe(`src/components/${STATIC_BLOCK}`);
    expect(res.line).toBe(STRONG_LINE);
    expect(res.note).toMatch(/created rule/);

    const tsx = readTsx(componentsDir);
    // strong got the class; its sibling <p> did not.
    expect(tsx).toMatch(/<strong[^>]*className="csync-1a2b"/);
    expect(tsx).toContain("css-devtools-sync");

    const css = readOverrides(srcDir);
    expect(css).toMatch(/\.csync-1a2b\s*\{\s*color: #ff0000;\s*\}/);
  });

  it("is idempotent: re-promoting the identical edit converges to a byte-identical fixed point", () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const cfg = makeCfg(root);
    const change = promoteChange("csync-dup", [
      { property: "color", value: "#00ff00" },
      { property: "font-weight", value: "700" },
    ]);

    applyInlinePromote(change, cfg);
    const tsx1 = readTsx(componentsDir);
    const css1 = readOverrides(srcDir);

    applyInlinePromote(change, cfg);
    const tsx2 = readTsx(componentsDir);
    const css2 = readOverrides(srcDir);

    expect(tsx2).toBe(tsx1);
    expect(css2).toBe(css1);
    // no duplicate class token, no duplicate rule
    expect(tsx2.match(/csync-dup/g)?.length).toBe(1);
    expect(css2.match(/\.csync-dup\s*\{/g)?.length).toBe(1);
  });

  it("re-promoting with DIFFERENT declarations replaces the rule body in place (no duplicate rule)", () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const cfg = makeCfg(root);

    applyInlinePromote(promoteChange("csync-x", [{ property: "color", value: "#111111" }]), cfg);
    const res2 = applyInlinePromote(
      promoteChange("csync-x", [
        { property: "color", value: "#222222" },
        { property: "padding", value: "8px 12px" },
      ]),
      cfg,
    );

    expect(res2.note).toMatch(/updated existing rule/);

    const css = readOverrides(srcDir);
    expect(css.match(/\.csync-x\s*\{/g)?.length).toBe(1); // still exactly one rule
    expect(css).toContain("color: #222222;");
    expect(css).toContain("padding: 8px 12px;");
    expect(css).not.toContain("#111111");

    // className added exactly once despite two promotes
    expect(readTsx(componentsDir).match(/csync-x/g)?.length).toBe(1);
  });

  it("preserves the value's !important flag", () => {
    const { root, srcDir } = makeWorkspace("");
    applyInlinePromote(
      promoteChange("csync-imp", [{ property: "color", value: "red !important" }]),
      makeCfg(root),
    );
    expect(readOverrides(srcDir)).toMatch(/color: red !important;/);
  });

  it("creates the overrides file when it does not yet exist", () => {
    const { root, srcDir } = makeWorkspace(null); // no index.css written
    expect(fs.existsSync(path.join(srcDir, "index.css"))).toBe(false);

    applyInlinePromote(
      promoteChange("csync-new", [{ property: "display", value: "flex" }]),
      makeCfg(root),
    );

    expect(fs.existsSync(path.join(srcDir, "index.css"))).toBe(true);
    expect(readOverrides(srcDir)).toMatch(/\.csync-new\s*\{\s*display: flex;\s*\}/);
  });

  it("appends to an overrides file that already has unrelated rules, leaving them untouched", () => {
    const existing = "body {\n  margin: 0;\n}\n";
    const { root, srcDir } = makeWorkspace(existing);
    applyInlinePromote(
      promoteChange("csync-app", [{ property: "color", value: "blue" }]),
      makeCfg(root),
    );
    const css = readOverrides(srcDir);
    expect(css).toContain("body {\n  margin: 0;\n}");
    expect(css).toMatch(/\.csync-app\s*\{\s*color: blue;\s*\}/);
  });
});

describe("applyInlinePromote — skip / reject paths leave BOTH files untouched", () => {
  it("skips (throws SkipChangeError) when the className is a dynamic expression", () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const cfg = makeCfg(root);

    // Overwrite the fixture's strong with a dynamic-className version at the same line.
    const tsx = readTsx(componentsDir);
    const dyn = tsx.replace(
      '<strong style={{ color: "#f3f4f8", fontSize: "14px" }}>',
      "<strong className={cls} style={{ color: \"#f3f4f8\" }}>",
    );
    expect(dyn).not.toBe(tsx);
    fs.writeFileSync(path.join(componentsDir, STATIC_BLOCK), dyn, "utf8");

    const beforeTsx = readTsx(componentsDir);
    const beforeCss = readOverrides(srcDir);

    expect(() =>
      applyInlinePromote(promoteChange("csync-dyn", [{ property: "color", value: "red" }]), cfg),
    ).toThrow(SkipChangeError);

    expect(readTsx(componentsDir)).toBe(beforeTsx); // JSX untouched
    expect(readOverrides(srcDir)).toBe(beforeCss); // overrides untouched — nothing half-written
  });

  it("rejects a declaration value carrying an injection payload, touching neither file", () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const cfg = makeCfg(root);
    const beforeTsx = readTsx(componentsDir);
    const beforeCss = readOverrides(srcDir);

    expect(() =>
      applyInlinePromote(
        promoteChange("csync-evil", [{ property: "color", value: "red } body { display: none" }]),
        cfg,
      ),
    ).toThrow(SkipChangeError);

    expect(readTsx(componentsDir)).toBe(beforeTsx);
    expect(readOverrides(srcDir)).toBe(beforeCss);
  });

  it("rejects an invalid CSS property name", () => {
    const { root } = makeWorkspace("");
    expect(() =>
      applyInlinePromote(
        promoteChange("csync-badprop", [{ property: "color; }", value: "red" }]),
        makeCfg(root),
      ),
    ).toThrow(SkipChangeError);
  });

  it("skips when no element exists at the given source line, touching neither file", () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const cfg = makeCfg(root);
    const beforeTsx = readTsx(componentsDir);
    const beforeCss = readOverrides(srcDir);

    const change = promoteChange("csync-missing", [{ property: "color", value: "red" }]);
    change.element.dataSourceLine = 999;

    expect(() => applyInlinePromote(change, cfg)).toThrow(SkipChangeError);
    expect(readTsx(componentsDir)).toBe(beforeTsx);
    expect(readOverrides(srcDir)).toBe(beforeCss);
  });
});

describe("promote-inline-style — contract validation", () => {
  it("rejects a className outside the csync-<base36> charset", () => {
    const bad = CaptureChangeSchema.safeParse({
      op: "promote-inline-style",
      className: "evil selector",
      declarations: [{ property: "color", value: "red" }],
      element: { tagName: "strong", classList: [], dataSourceFile: "a.tsx", dataSourceLine: 1 },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty declarations array", () => {
    const bad = CaptureChangeSchema.safeParse({
      op: "promote-inline-style",
      className: "csync-abc",
      declarations: [],
      element: { tagName: "strong", classList: [], dataSourceFile: "a.tsx", dataSourceLine: 1 },
    });
    expect(bad.success).toBe(false);
  });

  it("requires an instrumented element (source file + line)", () => {
    const bad = CaptureChangeSchema.safeParse({
      op: "promote-inline-style",
      className: "csync-abc",
      declarations: [{ property: "color", value: "red" }],
      element: { tagName: "strong", classList: [] }, // no dataSourceFile/Line
    });
    expect(bad.success).toBe(false);
  });

  it("accepts a well-formed change", () => {
    const ok = CaptureChangeSchema.safeParse({
      op: "promote-inline-style",
      className: "csync-1a2b3c",
      declarations: [{ property: "max-width", value: "420px" }],
      element: { tagName: "strong", classList: [], dataSourceFile: "a.tsx", dataSourceLine: 1 },
    });
    expect(ok.success).toBe(true);
  });
});

describe("promote-inline-style — end-to-end through /apply (routing + mode + contract)", () => {
  async function makeApp(workspaceRoot: string): Promise<FastifyInstance> {
    const app = await buildServer(makeCfg(workspaceRoot));
    apps.push(app);
    return app;
  }

  it("routes a valid promote through the full pipeline and reports mode 'promote'", async () => {
    const { root, srcDir, componentsDir } = makeWorkspace("");
    const app = await makeApp(root);

    const payload: CapturePayload = {
      url: "http://localhost:5173/#static",
      changes: [promoteChange("csync-e2e", [{ property: "color", value: "#abcdef" }])],
    };
    const res = await app.inject({ method: "POST", url: "/apply", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      applied: { mode: string; file: string }[];
      skipped: unknown[];
    };
    expect(body.skipped).toHaveLength(0);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]?.mode).toBe("promote");

    expect(readTsx(componentsDir)).toMatch(/className="csync-e2e"/);
    expect(readOverrides(srcDir)).toContain(".csync-e2e");
  });

  it("rejects a payload with a malformed className at the route boundary (400)", async () => {
    const { root } = makeWorkspace("");
    const app = await makeApp(root);
    const res = await app.inject({
      method: "POST",
      url: "/apply",
      payload: {
        url: "http://localhost:5173/#static",
        changes: [{ ...promoteChange("csync-ok", [{ property: "color", value: "red" }]), className: "Bad Class" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
