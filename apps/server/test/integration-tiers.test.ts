import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SourceMapGenerator } from "source-map-js";
import type { FastifyInstance } from "fastify";
import type { CapturePayload, CapturePayloadInput } from "@dev-sync/contract";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

/**
 * End-to-end integration tests: build a CapturePayload shaped exactly like
 * what the extension emits for each sync tier, POST it to the REAL /apply
 * route (buildServer + app.inject — full Fastify pipeline, zod parsing
 * included), and assert against a TEMP COPY of the actual test-app fixture
 * files. Every payload is re-POSTed a second time to prove the write is
 * idempotent (safe to retry) and never corrupts the file on a no-op re-sync.
 *
 * cfg.workspaceRoot below is exactly what DEV_SYNC_WORKSPACE_ROOT resolves to
 * at runtime (loadConfig() just realpath()s the env var into this same
 * field) — constructing Config directly, the same way server.test.ts does,
 * avoids mutating process.env across parallel test files while exercising
 * the identical code path.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../test-app/src/components");

const FIXTURE_FILES = [
  "PlainCard.css",
  "PlainCard.tsx",
  "ScssPanel.module.scss",
  "ScssPanel.tsx",
  "ModuleCard.module.css",
  "ModuleCard.tsx",
  "EmotionButton.tsx",
  "StyledBadge.tsx",
  "TailwindHero.tsx",
  "StaticBlock.tsx",
] as const;

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Copy the real test-app component fixtures into a fresh tmp workspace root. */
function makeWorkspace(): { root: string; componentsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-e2e-"));
  tmpDirs.push(root);
  const componentsDir = path.join(root, "src", "components");
  fs.mkdirSync(componentsDir, { recursive: true });
  for (const f of FIXTURE_FILES) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(componentsDir, f));
  }
  return { root: fs.realpathSync(root), componentsDir };
}

async function makeApp(workspaceRoot: string): Promise<FastifyInstance> {
  const cfg: Config = {
    workspaceRoot,
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined, // LLM placement never engages in these tests
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    // Journal inside the temp workspace tree — cleaned in afterEach, never the real home.
    journalDir: path.join(workspaceRoot, ".dev-sync-journal"),
  };
  const app = await buildServer(cfg);
  apps.push(app);
  return app;
}

function readFixture(componentsDir: string, name: (typeof FIXTURE_FILES)[number]): string {
  return fs.readFileSync(path.join(componentsDir, name), "utf8");
}

interface ApplyOutcomeLike {
  change: unknown;
  file: string;
  line?: number;
  mode: string;
  note?: string;
}
interface ApplyResultLike {
  applied: ApplyOutcomeLike[];
  skipped: { change: unknown; reason: string }[];
  needsPlacement: unknown[];
}

async function postApply(
  app: FastifyInstance,
  payload: CapturePayloadInput,
  applyMode: "preview" | "commit" = "commit",
): Promise<ApplyResultLike> {
  // These integration tests exercise the WRITE pipeline, so they commit by
  // default (applyMode now defaults to "preview" — a no-write dry run — at the
  // contract boundary). Pass "preview" explicitly to assert the dry-run path.
  const res = await app.inject({ method: "POST", url: "/apply", payload: { ...payload, applyMode } });
  expect(res.statusCode).toBe(200);
  return res.json() as ApplyResultLike;
}

/** data: URI sourcemap with exactly one mapping: generated (1,0) -> original (line, column) in `source`. */
function dataUriSourceMap(source: string, line: number, column: number): string {
  const gen = new SourceMapGenerator();
  gen.addMapping({ generated: { line: 1, column: 0 }, original: { line, column }, source });
  const json = JSON.stringify(gen.toJSON());
  return `data:application/json;charset=utf-8;base64,${Buffer.from(json, "utf8").toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Tier 1: plain CSS (PlainCard.css) — postcss AST match, modify + add @media
// ---------------------------------------------------------------------------

describe("integration: plain CSS tier (PlainCard.css)", () => {
  function payload(): CapturePayloadInput {
    const sheet = {
      id: "s-plain",
      sourceURL: "http://localhost:5173/src/components/PlainCard.css",
      origin: "regular" as const,
    };
    return {
      url: "http://localhost:5173/#plain",
      changes: [
        {
          op: "modify",
          styleSheet: sheet,
          selector: ".plain-card__badge",
          property: "background-color",
          oldValue: "#4f46e5",
          newValue: "#16a34a",
        },
        {
          op: "add-rule",
          styleSheet: sheet,
          selector: ".plain-card",
          mediaText: "(min-width: 1024px)",
          ruleText: ".plain-card { max-width: 480px; }",
        },
      ],
    };
  }

  it("modifies the declaration and adds the new @media block, then is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const first = await postApply(app, payload());
    expect(first.applied).toHaveLength(2);
    expect(first.skipped).toHaveLength(0);
    for (const outcome of first.applied) {
      expect(outcome.file).toBe("src/components/PlainCard.css");
      expect(outcome.mode).toBe("postcss");
    }

    const afterFirst = readFixture(componentsDir, "PlainCard.css");
    expect(afterFirst).toContain("background-color: #16a34a;");
    expect(afterFirst).not.toContain("background-color: #4f46e5;");
    expect(afterFirst).toMatch(/@media \(min-width: 1024px\)\s*\{\s*\.plain-card\s*\{\s*max-width: 480px;/);
    // untouched declarations survive byte-identical
    expect(afterFirst).toContain("border-radius: 12px;");
    expect(afterFirst).toContain("@media (max-width: 600px)");

    const second = await postApply(app, payload());
    expect(second.applied).toHaveLength(2);
    expect(second.skipped).toHaveLength(0);
    const addRuleOutcome = second.applied.find((a) => (a.change as { op: string }).op === "add-rule");
    expect(addRuleOutcome?.note).toMatch(/already present.*skipped duplicate insert/i);

    const afterSecond = readFixture(componentsDir, "PlainCard.css");
    expect(afterSecond).toBe(afterFirst); // byte-identical fixed point — no duplication
    expect(afterSecond.match(/max-width: 480px/g)?.length).toBe(1);
  });

  it("skip path: unknown selector returns a reason and leaves the file untouched", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "PlainCard.css");

    const result = await postApply(app, {
      url: "http://localhost:5173/#plain",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-plain",
            sourceURL: "http://localhost:5173/src/components/PlainCard.css",
            origin: "regular",
          },
          selector: ".does-not-exist",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
      ],
    });

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/selector not found/);
    expect(readFixture(componentsDir, "PlainCard.css")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Sass module via sourcemap (ScssPanel.module.scss)
// ---------------------------------------------------------------------------

describe("integration: Sass module tier via sourcemap (ScssPanel.module.scss)", () => {
  const SOURCE_REL = "src/components/ScssPanel.module.scss";
  const ORIGINAL_LINE = 14; // "  background-color: $panel-bg;"
  const ORIGINAL_COLUMN = 2;

  function payload(selector = ".panel"): CapturePayloadInput {
    return {
      url: "http://localhost:5173/#scss",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-scss",
            sourceURL: "http://localhost:5173/src/components/ScssPanel.module.scss?used",
            sourceMapURL: dataUriSourceMap(SOURCE_REL, ORIGINAL_LINE, ORIGINAL_COLUMN),
            origin: "regular",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          selector,
          property: "background-color",
          oldValue: "$panel-bg",
          newValue: "#0f1420",
        },
      ],
    };
  }

  it("resolves through the sourcemap to the ORIGINAL .scss source and is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const first = await postApply(app, payload());
    expect(first.skipped).toHaveLength(0);
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]?.file).toBe(SOURCE_REL);
    expect(first.applied[0]?.mode).toBe("sourcemap");

    const afterFirst = readFixture(componentsDir, "ScssPanel.module.scss");
    // anchored to the OUTER .panel block's own first two declarations only —
    // a plain `.not.toContain($panel-bg)` would be wrong here, since the
    // nested .header rule legitimately keeps its own $panel-bg reference.
    expect(afterFirst).toMatch(
      /\.panel \{\n\s*background-color: #0f1420;\n\s*border: 1px solid \$panel-border;/,
    );
    // the nested .header rule's OWN background-color (a different declaration
    // entirely) must survive untouched — proves declsOf() didn't walk nested rules
    expect(afterFirst).toContain("background-color: color.adjust($panel-bg, $lightness: -3%);");

    const second = await postApply(app, payload());
    expect(second.applied).toHaveLength(1);
    const afterSecond = readFixture(componentsDir, "ScssPanel.module.scss");
    expect(afterSecond).toBe(afterFirst);
  });

  it("skip path: neither the selector NOR the sourcemap-mapped position lands anywhere — genuinely unresolvable, returns a reason without touching the file", async () => {
    // Sourcemap points at line 1 (the file's leading comment, before any
    // rule) — the position fallback (see the CSS Modules tests below) has
    // nothing to land on either, so this stays a true skip.
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "ScssPanel.module.scss");

    const result = await postApply(app, {
      url: "http://localhost:5173/#scss",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-scss",
            sourceURL: "http://localhost:5173/src/components/ScssPanel.module.scss?used",
            sourceMapURL: dataUriSourceMap(SOURCE_REL, 1, 0),
            origin: "regular",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          selector: ".does-not-exist",
          property: "background-color",
          oldValue: "$panel-bg",
          newValue: "#0f1420",
        },
      ],
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/selector not found/);
    expect(readFixture(componentsDir, "ScssPanel.module.scss")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tier 2b: CSS Modules position-based demangle — hashed selector, DevTools
// text never matches the source's plain author-written class name, so the
// write must locate the rule by the sourcemap-mapped ORIGINAL position
// instead (apply-css.ts's pickRuleForChange -> pickRuleAtPosition fallback).
// ---------------------------------------------------------------------------

describe("integration: CSS Modules position-based demangle — plain .module.css (ModuleCard.module.css)", () => {
  const SOURCE_REL = "src/components/ModuleCard.module.css";
  const TITLE_LINE = 23; // "  color: #f3f0fb;" inside .title
  const TITLE_COLUMN = 2;

  function hashedPayload(): CapturePayloadInput {
    return {
      url: "http://localhost:5173/#module-card",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-modulecard",
            sourceURL: "http://localhost:5173/src/components/ModuleCard.module.css?used",
            sourceMapURL: dataUriSourceMap(SOURCE_REL, TITLE_LINE, TITLE_COLUMN),
            origin: "regular",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          // DevTools reports the HASHED compiled selector — this string
          // never appears anywhere in the source .module.css file.
          selector: ".ModuleCard_title__x7a9",
          property: "color",
          oldValue: "#f3f0fb",
          newValue: "#ffffff",
        },
      ],
    };
  }

  it("a hashed selector that matches nothing by name is located by source position and edits the correct rule", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const first = await postApply(app, hashedPayload());
    expect(first.skipped).toHaveLength(0);
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]?.file).toBe(SOURCE_REL);
    expect(first.applied[0]?.mode).toBe("sourcemap");
    expect(first.applied[0]?.note).toMatch(/not found by name/i);

    const afterFirst = readFixture(componentsDir, "ModuleCard.module.css");
    expect(afterFirst).toMatch(/\.title \{[^}]*color: #ffffff;/);
    expect(afterFirst).not.toContain("color: #f3f0fb;");
    // sibling rules (.card, .body, .action) are byte-identical — only
    // .title's own color declaration changed
    expect(afterFirst).toContain("background-color: #1f1a2e;"); // .card untouched
    expect(afterFirst).toContain("color: #a89fc2;"); // .body untouched
    expect(afterFirst).toContain("background-color: #7c5cf0;"); // .action untouched

    const second = await postApply(app, hashedPayload());
    expect(second.applied).toHaveLength(1);
    const afterSecond = readFixture(componentsDir, "ModuleCard.module.css");
    expect(afterSecond).toBe(afterFirst); // idempotent fixed point
  });

  it("skip path: the position-matched rule exists but the property doesn't — still skips cleanly, not a false match", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "ModuleCard.module.css");

    const result = await postApply(app, {
      url: "http://localhost:5173/#module-card",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-modulecard",
            sourceURL: "http://localhost:5173/src/components/ModuleCard.module.css?used",
            sourceMapURL: dataUriSourceMap(SOURCE_REL, TITLE_LINE, TITLE_COLUMN),
            origin: "regular",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          selector: ".ModuleCard_title__x7a9",
          property: "z-index", // .title has no z-index declaration
          oldValue: "1",
          newValue: "2",
        },
      ],
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/declaration "z-index" not found/);
    expect(readFixture(componentsDir, "ModuleCard.module.css")).toBe(before);
  });
});

describe("integration: CSS Modules position-based demangle — NESTED Sass rule (ScssPanel.module.scss .header)", () => {
  const SOURCE_REL = "src/components/ScssPanel.module.scss";
  const HEADER_PADDING_LINE = 24; // "    padding: 14px 18px;" inside .panel .header

  it("a hashed selector mapped to a line inside the NESTED .header rule edits .header, not the outer .panel", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const change = {
      op: "modify" as const,
      styleSheet: {
        id: "s-scss-header",
        sourceURL: "http://localhost:5173/src/components/ScssPanel.module.scss?used",
        sourceMapURL: dataUriSourceMap(SOURCE_REL, HEADER_PADDING_LINE, 4),
        origin: "regular" as const,
      },
      range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
      // The compiled selector for a nested Sass rule is FLATTENED
      // (".panel .header"), which never matches the source's own nested
      // ".header" rule text either — same fallback mechanism as the hash case.
      selector: ".panel .header",
      property: "padding",
      oldValue: "14px 18px",
      newValue: "18px 22px",
    };

    const result = await postApply(app, { url: "http://localhost:5173/#scss", changes: [change] });
    expect(result.skipped).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.note).toMatch(/not found by name/i);

    const after = readFixture(componentsDir, "ScssPanel.module.scss");
    expect(after).toContain("padding: 18px 22px;");
    expect(after).not.toContain("padding: 14px 18px;");
    // the OUTER .panel's own declarations (none named "padding") and the
    // SIBLING nested .row rule's own "padding: 11px 18px;" survive untouched
    expect(after).toContain("padding: 11px 18px;");
    expect(after).toContain("background-color: $panel-bg;"); // .panel's own decl, untouched

    const second = await postApply(app, { url: "http://localhost:5173/#scss", changes: [change] });
    expect(second.applied).toHaveLength(1);
    expect(readFixture(componentsDir, "ScssPanel.module.scss")).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// Tier 3: CSS-in-JS (EmotionButton.tsx template literal) via sourcemap
// ---------------------------------------------------------------------------

describe("integration: CSS-in-JS tier (EmotionButton.tsx)", () => {
  const SOURCE_REL = "src/components/EmotionButton.tsx";
  const ORIGINAL_LINE = 20; // "  border-radius: 8px;" inside the StyledButton template
  const ORIGINAL_COLUMN = 2;

  function payload(property = "border-radius", oldValue = "8px", newValue = "14px"): CapturePayloadInput {
    return {
      url: "http://localhost:5173/#emotion",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-emotion",
            sourceURL: "", // injected <style> tag has no href, as CDP reports for emotion in dev
            sourceMapURL: dataUriSourceMap(SOURCE_REL, ORIGINAL_LINE, ORIGINAL_COLUMN),
            origin: "injected",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          selector: ".css-abc123--StyledButton",
          property,
          oldValue,
          newValue,
        },
      ],
    };
  }

  it("edits the emotion template literal in place and is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const first = await postApply(app, payload());
    expect(first.skipped).toHaveLength(0);
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]?.file).toBe(SOURCE_REL);
    expect(first.applied[0]?.mode).toBe("cssinjs");

    const afterFirst = readFixture(componentsDir, "EmotionButton.tsx");
    expect(afterFirst).toContain("border-radius: 14px;");
    expect(afterFirst).not.toContain("border-radius: 8px;");
    // sibling declarations + the unrelated Wrap/ClickCount templates survive untouched
    expect(afterFirst).toContain("font-size: 14px;");
    expect(afterFirst).toContain("gap: 16px;");

    const second = await postApply(app, payload());
    expect(second.applied).toHaveLength(1);
    const afterSecond = readFixture(componentsDir, "EmotionButton.tsx");
    expect(afterSecond).toBe(afterFirst);
  });

  it("skip path: a declaration absent from the template returns a reason without touching the file", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "EmotionButton.tsx");

    const result = await postApply(app, payload("text-decoration", "none", "underline"));
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/not found in the css-in-js template/);
    expect(readFixture(componentsDir, "EmotionButton.tsx")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tier 3b: CSS-in-JS PARITY — styled-components (StyledBadge.tsx), distinct
// from EmotionButton's @emotion/styled tier. Same writer (cssinjs.ts), same
// STYLE_TAG_ROOTS "styled" detection, but a DIFFERENT babel plugin
// (babel-plugin-styled-components) producing the sourcemap that locates the
// template. Proves the writer is genuinely generic across both libraries,
// not emotion-specific, AND that two SEPARATE styled.* templates in the same
// file (Pill, Dot) are disambiguated correctly by mappedLine.
// ---------------------------------------------------------------------------

describe("integration: CSS-in-JS PARITY tier — styled-components (StyledBadge.tsx)", () => {
  const SOURCE_REL = "src/components/StyledBadge.tsx";
  const PILL_LINE = 19; // "  border-radius: 999px;" inside the Pill template
  const DOT_LINE = 35; // "  border-radius: 50%;" inside the Dot template

  function change(mappedLine: number, selector: string, oldValue: string, newValue: string) {
    return {
      op: "modify" as const,
      styleSheet: {
        id: `s-styled-${selector}`,
        sourceURL: "", // styled-components' injected <style> tag has no href, same as emotion
        sourceMapURL: dataUriSourceMap(SOURCE_REL, mappedLine, 2),
        origin: "injected" as const,
      },
      range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
      selector,
      property: "border-radius",
      oldValue,
      newValue,
    };
  }

  it("edits the styled-components template literal in place and is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5173/#styled",
      changes: [change(PILL_LINE, ".StyledBadge__Pill-sc-abc123-0", "999px", "12px")],
    };

    const first = await postApply(app, payload);
    expect(first.skipped).toHaveLength(0);
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]?.file).toBe(SOURCE_REL);
    expect(first.applied[0]?.mode).toBe("cssinjs");

    const afterFirst = readFixture(componentsDir, "StyledBadge.tsx");
    expect(afterFirst).toContain("border-radius: 12px;");
    expect(afterFirst).not.toContain("border-radius: 999px;");
    // the OTHER template (Dot)'s own border-radius survives untouched
    expect(afterFirst).toContain("border-radius: 50%;");
    // interpolations (tone-dependent values) survive untouched
    expect(afterFirst).toContain('tone === "ok" ? "#065f46" : "#78350f"');

    const second = await postApply(app, payload);
    expect(second.applied).toHaveLength(1);
    const afterSecond = readFixture(componentsDir, "StyledBadge.tsx");
    expect(afterSecond).toBe(afterFirst);
  });

  it("disambiguates TWO separate styled.* templates in the same file by mappedLine — a batch touching both Pill and Dot lands each edit in the right one", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const result = await postApply(app, {
      url: "http://localhost:5173/#styled",
      changes: [
        change(PILL_LINE, ".StyledBadge__Pill-sc-abc123-0", "999px", "16px"),
        change(DOT_LINE, ".StyledBadge__Dot-sc-def456-1", "50%", "9999px"),
      ],
    });
    expect(result.skipped).toHaveLength(0);
    expect(result.applied).toHaveLength(2);

    const after = readFixture(componentsDir, "StyledBadge.tsx");
    expect(after).toMatch(/border-radius: 16px;[\s\S]*Dot/); // Pill's edit lands before Dot's declaration
    expect(after).toContain("border-radius: 9999px;");
    expect(after).not.toContain("border-radius: 999px;");
    expect(after).not.toContain("border-radius: 50%;");
  });

  it("skip path: a declaration absent from the template returns a reason without touching the file", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "StyledBadge.tsx");

    const result = await postApply(app, {
      url: "http://localhost:5173/#styled",
      changes: [change(PILL_LINE, ".StyledBadge__Pill-sc-abc123-0", "nonexistent", "nope")].map((c) => ({
        ...c,
        property: "text-decoration",
        oldValue: "none",
        newValue: "underline",
      })),
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/not found in the css-in-js template/);
    expect(readFixture(componentsDir, "StyledBadge.tsx")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tier 4: Tailwind classlist (TailwindHero.tsx className) — never touches CSS
// ---------------------------------------------------------------------------

describe("integration: Tailwind classlist tier (TailwindHero.tsx)", () => {
  const SOURCE_REL = "src/components/TailwindHero.tsx";
  const HERO_LINE = 9; // <div className="rounded-2xl ... p-8 shadow-xl">

  function payload(): CapturePayloadInput {
    return {
      url: "http://localhost:5173/#tailwind",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-tw",
            sourceURL: "http://localhost:5173/src/index.css", // Tailwind's generated sheet — must NOT be edited
            origin: "regular",
          },
          selector: ".p-8",
          property: "padding",
          oldValue: "2rem",
          newValue: "48px",
          element: {
            tagName: "div",
            classList: [
              "rounded-2xl",
              "bg-gradient-to-br",
              "from-indigo-600",
              "to-violet-800",
              "p-8",
              "shadow-xl",
            ],
            dataSourceFile: SOURCE_REL,
            dataSourceLine: HERO_LINE,
            dataSourceComponent: "TailwindHero",
          },
        },
      ],
    };
  }

  it("rewrites the className token list (not any stylesheet) and is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const first = await postApply(app, payload());
    expect(first.skipped).toHaveLength(0);
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]?.file).toBe(SOURCE_REL);
    expect(first.applied[0]?.mode).toBe("classlist");

    const afterFirst = readFixture(componentsDir, "TailwindHero.tsx");
    // Scoped to the edited className attribute itself — the file's own doc
    // comment ("e.g. bg-indigo-600 -> bg-emerald-600, p-8 -> p-12") also
    // contains the literal substring "p-8", so a whole-file regex would
    // false-positive on unrelated prose.
    expect(afterFirst).toContain(
      'className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-800 shadow-xl p-[48px]"',
    );
    expect(afterFirst).not.toMatch(/className="[^"]*\bp-8\b[^"]*"/);
    expect(afterFirst).toContain("p-[48px]");
    expect(afterFirst).toContain("rounded-2xl");
    expect(afterFirst).toContain("shadow-xl");
    // the "Tailwind sheet" named in styleSheet.sourceURL is never written to
    expect(fs.existsSync(path.join(root, "src", "index.css"))).toBe(false);

    const second = await postApply(app, payload());
    expect(second.applied).toHaveLength(1);
    const afterSecond = readFixture(componentsDir, "TailwindHero.tsx");
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.match(/p-\[48px\]/g)?.length).toBe(1);
  });

  it("skip path: delete-decl on a non-utility selector on a tailwind sheet returns a reason without touching the file", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "TailwindHero.tsx");

    const result = await postApply(app, {
      url: "http://localhost:5173/#tailwind",
      changes: [
        {
          op: "delete-decl",
          styleSheet: {
            id: "s-tw",
            sourceURL: "http://localhost:5173/tailwind.css",
            origin: "regular",
          },
          selector: ".custom-hero-title", // not utility-shaped -> tokenEdits() rejects delete-decl
          property: "color",
          element: {
            tagName: "div",
            classList: ["rounded-2xl"],
            dataSourceFile: SOURCE_REL,
            dataSourceLine: HERO_LINE,
          },
        },
      ],
    });

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/cannot map delete-decl/);
    expect(readFixture(componentsDir, "TailwindHero.tsx")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tier 5: markup set-attr + set-text (StaticBlock.tsx) — the jsx writer
// ---------------------------------------------------------------------------

describe("integration: markup tier — set-attr + set-text (StaticBlock.tsx)", () => {
  const SOURCE_REL = "src/components/StaticBlock.tsx";
  const NAV_LINE = 33; // <nav aria-label="Footer navigation" ...>
  const STRONG_LINE = 25; // <strong ...>css-devtools-sync</strong>

  function payload(): CapturePayloadInput {
    return {
      url: "http://localhost:5173/#static",
      changes: [
        {
          op: "set-attr",
          element: {
            tagName: "nav",
            classList: [],
            dataSourceFile: SOURCE_REL,
            dataSourceLine: NAV_LINE,
            dataSourceComponent: "StaticBlock",
          },
          attribute: "aria-label",
          value: "Site footer",
        },
        {
          op: "set-text",
          element: {
            tagName: "strong",
            classList: [],
            dataSourceFile: SOURCE_REL,
            dataSourceLine: STRONG_LINE,
            dataSourceComponent: "StaticBlock",
          },
          newText: "css-devtools-sync — synced",
        },
      ],
    };
  }

  it("edits the attribute and text directly in JSX source and is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const first = await postApply(app, payload());
    expect(first.skipped).toHaveLength(0);
    expect(first.applied).toHaveLength(2);
    for (const outcome of first.applied) {
      expect(outcome.file).toBe(SOURCE_REL);
      expect(outcome.mode).toBe("jsx");
    }

    const afterFirst = readFixture(componentsDir, "StaticBlock.tsx");
    expect(afterFirst).toContain('aria-label="Site footer"');
    expect(afterFirst).not.toContain('aria-label="Footer navigation"');
    expect(afterFirst).toContain("css-devtools-sync — synced");
    expect(afterFirst).not.toMatch(/>\s*css-devtools-sync\s*</);
    // untouched sibling literal content survives
    expect(afterFirst).toContain("v0.0.1 — local fixture build");
    expect(afterFirst).toContain('title="Jump to the plain CSS tier"');

    const second = await postApply(app, payload());
    expect(second.applied).toHaveLength(2);
    const afterSecond = readFixture(componentsDir, "StaticBlock.tsx");
    expect(afterSecond).toBe(afterFirst);
  });

  it("skip path: no element at the given source line returns a reason without touching the file", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);
    const before = readFixture(componentsDir, "StaticBlock.tsx");

    const result = await postApply(app, {
      url: "http://localhost:5173/#static",
      changes: [
        {
          op: "set-attr",
          element: {
            tagName: "nav",
            classList: [],
            dataSourceFile: SOURCE_REL,
            dataSourceLine: 999,
          },
          attribute: "aria-label",
          value: "x",
        },
      ],
    });

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/no JSX element found/);
    expect(readFixture(componentsDir, "StaticBlock.tsx")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Cross-tier: one payload touching every tier at once, applied twice
// ---------------------------------------------------------------------------

describe("integration: one CapturePayload spanning all five tiers", () => {
  it("applies every tier's change in a single batch and is fully idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5173/",
      changes: [
        {
          op: "modify",
          styleSheet: {
            id: "s-plain",
            sourceURL: "http://localhost:5173/src/components/PlainCard.css",
            origin: "regular",
          },
          selector: ".plain-card__badge",
          property: "background-color",
          oldValue: "#4f46e5",
          newValue: "#16a34a",
        },
        {
          op: "modify",
          styleSheet: {
            id: "s-scss",
            sourceURL: "http://localhost:5173/src/components/ScssPanel.module.scss?used",
            sourceMapURL: dataUriSourceMap("src/components/ScssPanel.module.scss", 14, 2),
            origin: "regular",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          selector: ".panel",
          property: "background-color",
          oldValue: "$panel-bg",
          newValue: "#0f1420",
        },
        {
          op: "modify",
          styleSheet: {
            id: "s-emotion",
            sourceURL: "",
            sourceMapURL: dataUriSourceMap("src/components/EmotionButton.tsx", 20, 2),
            origin: "injected",
          },
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 10 },
          selector: ".css-abc123--StyledButton",
          property: "border-radius",
          oldValue: "8px",
          newValue: "14px",
        },
        {
          op: "modify",
          styleSheet: {
            id: "s-tw",
            sourceURL: "http://localhost:5173/src/index.css",
            origin: "regular",
          },
          selector: ".p-8",
          property: "padding",
          oldValue: "2rem",
          newValue: "48px",
          element: {
            tagName: "div",
            classList: ["rounded-2xl", "p-8"],
            dataSourceFile: "src/components/TailwindHero.tsx",
            dataSourceLine: 9,
          },
        },
        {
          op: "set-attr",
          element: {
            tagName: "nav",
            classList: [],
            dataSourceFile: "src/components/StaticBlock.tsx",
            dataSourceLine: 33,
          },
          attribute: "aria-label",
          value: "Site footer",
        },
      ],
    };

    const first = await postApply(app, payload);
    expect(first.skipped).toHaveLength(0);
    expect(first.needsPlacement).toHaveLength(0);
    expect(first.applied).toHaveLength(5);
    expect(new Set(first.applied.map((a) => a.mode))).toEqual(
      new Set(["postcss", "sourcemap", "cssinjs", "classlist", "jsx"]),
    );

    const snapshot = FIXTURE_FILES.map((f) => readFixture(componentsDir, f));

    const second = await postApply(app, payload);
    expect(second.skipped).toHaveLength(0);
    expect(second.applied).toHaveLength(5);

    const snapshot2 = FIXTURE_FILES.map((f) => readFixture(componentsDir, f));
    expect(snapshot2).toEqual(snapshot); // every file is a stable fixed point
  });
});

// ---------------------------------------------------------------------------
// Batch: multiple changes targeting the SAME file in one /apply — the
// orchestrator (applyPayload in apply.ts) processes changes sequentially,
// re-reading and re-writing the file on disk for each one, so edits to
// DISJOINT rules/declarations within one file must compose correctly
// regardless of which order they're listed in.
// ---------------------------------------------------------------------------

describe("integration: a batch with multiple changes targeting the SAME file (PlainCard.css)", () => {
  function changes(): CapturePayload["changes"] {
    const sheet = {
      id: "s-plain-batch",
      sourceURL: "http://localhost:5173/src/components/PlainCard.css",
      origin: "regular" as const,
    };
    return [
      {
        op: "modify",
        styleSheet: sheet,
        selector: ".plain-card__badge",
        property: "background-color",
        oldValue: "#4f46e5",
        newValue: "#16a34a",
      },
      {
        op: "add-decl",
        styleSheet: sheet,
        selector: ".plain-card__toggle",
        property: "opacity",
        newValue: "0.9",
      },
      {
        op: "delete-decl",
        styleSheet: sheet,
        selector: ".plain-card__details",
        property: "padding-top",
      },
    ];
  }

  it("applies all three changes cumulatively and correctly, and is idempotent on re-apply", async () => {
    const { root, componentsDir } = makeWorkspace();
    const app = await makeApp(root);

    const result = await postApply(app, { url: "http://localhost:5173/#plain", changes: changes() });
    expect(result.skipped).toHaveLength(0);
    expect(result.applied).toHaveLength(3);
    for (const outcome of result.applied) {
      expect(outcome.file).toBe("src/components/PlainCard.css");
    }

    const after = readFixture(componentsDir, "PlainCard.css");
    // change 1 landed
    expect(after).toMatch(/\.plain-card__badge \{[^}]*background-color: #16a34a;/);
    expect(after).not.toContain("background-color: #4f46e5;");
    // change 2 landed, ADDITIVE to the existing declarations (not replacing them)
    expect(after).toMatch(/\.plain-card__toggle \{[^}]*opacity: 0\.9;/);
    expect(after).toContain("cursor: pointer;"); // .plain-card__toggle's original last decl survives
    // change 3 landed — padding-top removed, the rule's OTHER decls survive
    const detailsBlock = /\.plain-card__details \{([^}]*)\}/.exec(after)?.[1] ?? "";
    expect(detailsBlock).not.toContain("padding-top");
    expect(detailsBlock).toContain("margin-top: 16px;");
    expect(detailsBlock).toContain("border-top: 1px dashed #2c3044;");
    // untouched rules are byte-identical
    expect(after).toContain("background-color: #1a1d2a;"); // .plain-card, untouched
    expect(after).toContain("transform: translateY(-2px);"); // .plain-card:hover, untouched

    // Re-apply the SAME batch. modify and add-decl are idempotent-as-applied
    // (setting the same value again / finding the decl already present).
    // delete-decl is idempotent-as-SKIPPED instead: there is no "padding-top"
    // left to remove the second time, so it reports skipped with a reason
    // rather than a no-op "applied" — still a SAFE retry, since either way
    // the file converges to (and stays at) the exact same byte-identical
    // state, which is what actually matters for retry-safety.
    const second = await postApply(app, { url: "http://localhost:5173/#plain", changes: changes() });
    expect(second.applied).toHaveLength(2);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.reason).toMatch(/"padding-top" not found/);
    const afterSecond = readFixture(componentsDir, "PlainCard.css");
    expect(afterSecond).toBe(after); // stable fixed point, no duplicate opacity/etc.
  });

  it("produces the SAME final file regardless of the order the batch lists the changes in", async () => {
    const forward = makeWorkspace();
    const reversed = makeWorkspace();
    const appForward = await makeApp(forward.root);
    const appReversed = await makeApp(reversed.root);

    const forwardResult = await postApply(appForward, {
      url: "http://localhost:5173/#plain",
      changes: changes(),
    });
    const reversedResult = await postApply(appReversed, {
      url: "http://localhost:5173/#plain",
      changes: [...changes()].reverse(),
    });

    expect(forwardResult.skipped).toHaveLength(0);
    expect(reversedResult.skipped).toHaveLength(0);
    expect(forwardResult.applied).toHaveLength(3);
    expect(reversedResult.applied).toHaveLength(3);

    const forwardFile = readFixture(forward.componentsDir, "PlainCard.css");
    const reversedFile = readFixture(reversed.componentsDir, "PlainCard.css");
    expect(reversedFile).toBe(forwardFile);
  });
});
