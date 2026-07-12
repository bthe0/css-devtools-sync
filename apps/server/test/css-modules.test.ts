import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SourceMapGenerator } from "source-map-js";
import type { StyleSheetRef } from "@dev-sync/contract";
import { applyCssChange } from "../src/apply-css.js";
import { cssSyntaxForFile, resolveTargetForChange } from "../src/resolve.js";
import { SkipChangeError } from "../src/errors.js";

/**
 * apps/server/test/css-modules.test.ts — unit-level proof of the CSS Modules
 * / Sass-nesting position-based demangle path, isolated from the full HTTP
 * pipeline (see integration-tiers.test.ts for the end-to-end versions
 * against the real test-app fixtures). Exercises resolve.ts's
 * resolveTargetForChange (sourcemap -> {file, line, column}) feeding
 * directly into apply-css.ts's applyCssChange({ position }) fallback.
 *
 * The core claim under test: a change whose `selector` is the COMPILED
 * (hashed, or Sass-flattened) text — which never appears anywhere in the
 * SOURCE file — must still land on the correct rule, located by the
 * sourcemap-mapped ORIGINAL position, not by matching the selector name.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** data: URI sourcemap with exactly one mapping: generated (1,0) -> original (line,column) in `source`. */
function dataUriSourceMap(source: string, line: number, column: number): string {
  const gen = new SourceMapGenerator();
  gen.addMapping({ generated: { line: 1, column: 0 }, original: { line, column }, source });
  const json = JSON.stringify(gen.toJSON());
  return `data:application/json;charset=utf-8;base64,${Buffer.from(json, "utf8").toString("base64")}`;
}

/** Copy a fixture from test/fixtures into a fresh temp workspace root at `relPath`. */
function makeWorkspace(fixtureName: string, relPath: string): { root: string; relPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-cssmod-"));
  tmpDirs.push(root);
  const dest = path.join(root, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures", fixtureName), dest);
  return { root: fs.realpathSync(root), relPath };
}

// ---------------------------------------------------------------------------
// Plain CSS Module (.module.css) — no compiler step, just a hashed selector.
// ---------------------------------------------------------------------------

describe("CSS Modules position-based demangle — plain .module.css", () => {
  const RELPATH = "src/Card.module.css";
  const TITLE_COLOR_LINE = 13; // "  color: #222222;" inside .title
  const TITLE_COLOR_COLUMN = 2;
  const CARD_PADDING_LINE = 9; // "  padding: 12px;" inside .card
  const CARD_PADDING_COLUMN = 2;

  function sheetAt(root: string, line: number, column: number): StyleSheetRef {
    return {
      id: "s1",
      sourceURL: "http://localhost:5173/src/Card.module.css?t=hash123",
      sourceMapURL: dataUriSourceMap(RELPATH, line, column),
      origin: "regular",
    };
  }

  it("resolveTargetForChange follows the sourcemap to the source file + ORIGINAL line/column", () => {
    const { root } = makeWorkspace("css-module.module.css", RELPATH);
    const target = resolveTargetForChange(root, sheetAt(root, TITLE_COLOR_LINE, TITLE_COLOR_COLUMN), {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 5,
    });
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("css");
    expect(target?.viaSourceMap).toBe(true);
    expect(target?.line).toBe(TITLE_COLOR_LINE);
    expect(target?.column).toBe(TITLE_COLOR_COLUMN);
  });

  it("a hashed selector that does not exist anywhere in the source is located by POSITION and edits the correct rule", () => {
    const { root } = makeWorkspace("css-module.module.css", RELPATH);
    const sheet = sheetAt(root, TITLE_COLOR_LINE, TITLE_COLOR_COLUMN);
    const target = resolveTargetForChange(root, sheet, {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 5,
    });
    expect(target).not.toBeNull();

    const source = fs.readFileSync(path.join(root, RELPATH), "utf8");
    const res = applyCssChange(
      source,
      {
        op: "modify",
        styleSheet: sheet,
        // Never appears in the source file — a real CSS Modules hash.
        selector: ".Card_title__x7a9",
        property: "color",
        oldValue: "#222222",
        newValue: "#eeeeee",
      },
      {
        syntax: cssSyntaxForFile(RELPATH),
        position: target?.line !== null && target ? { line: target.line, column: target.column } : undefined,
      },
    );

    expect(res.css).toContain("color: #eeeeee;");
    expect(res.css).not.toContain("color: #222222;");
    // the SIBLING rule (.card) must survive completely untouched
    expect(res.css).toContain(".card {\n  padding: 12px;\n}");
    expect(res.note).toMatch(/not found by name/i);
  });

  it("add-decl via a hashed selector appends the new declaration to the position-matched rule", () => {
    const { root } = makeWorkspace("css-module.module.css", RELPATH);
    const sheet = sheetAt(root, CARD_PADDING_LINE, CARD_PADDING_COLUMN);
    const target = resolveTargetForChange(root, sheet, {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 5,
    });
    const source = fs.readFileSync(path.join(root, RELPATH), "utf8");
    const res = applyCssChange(
      source,
      {
        op: "add-decl",
        styleSheet: sheet,
        selector: ".Card_card__z9k2",
        property: "cursor",
        newValue: "pointer",
      },
      {
        syntax: cssSyntaxForFile(RELPATH),
        position: target?.line !== null && target ? { line: target.line, column: target.column } : undefined,
      },
    );
    expect(res.css).toMatch(/\.card \{[^}]*cursor: pointer;/);
    // .title is untouched
    expect(res.css).toContain(".title {\n  color: #222222;\n  font-size: 14px;\n}");
  });

  it("without ANY position hint, an unresolvable hashed selector still throws SkipChangeError (no silent no-op)", () => {
    const { root } = makeWorkspace("css-module.module.css", RELPATH);
    const source = fs.readFileSync(path.join(root, RELPATH), "utf8");
    expect(() =>
      applyCssChange(
        source,
        {
          op: "modify",
          styleSheet: sheetAt(root, TITLE_COLOR_LINE, TITLE_COLOR_COLUMN),
          selector: ".Card_title__x7a9",
          property: "color",
          oldValue: "#222222",
          newValue: "#eeeeee",
        },
        { syntax: cssSyntaxForFile(RELPATH) }, // no `position` supplied
      ),
    ).toThrow(SkipChangeError);
  });

  it("position resolves a real rule but the requested property is absent there — still a clean skip, not a false match", () => {
    const { root } = makeWorkspace("css-module.module.css", RELPATH);
    const sheet = sheetAt(root, TITLE_COLOR_LINE, TITLE_COLOR_COLUMN);
    const target = resolveTargetForChange(root, sheet, {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 5,
    });
    const source = fs.readFileSync(path.join(root, RELPATH), "utf8");
    expect(() =>
      applyCssChange(
        source,
        {
          op: "modify",
          styleSheet: sheet,
          selector: ".Card_title__x7a9",
          property: "z-index", // .title has no z-index
          oldValue: "1",
          newValue: "2",
        },
        {
          syntax: cssSyntaxForFile(RELPATH),
          position: target?.line !== null && target ? { line: target.line, column: target.column } : undefined,
        },
      ),
    ).toThrow(/declaration "z-index" not found/);
  });
});

// ---------------------------------------------------------------------------
// Sass CSS Module with REAL nesting (.module.scss) — a rule nested inside
// its parent selector. The compiled selector is BOTH hashed AND flattened
// (".panel .header" rather than the source's nested ".header"), so name
// matching fails for two independent reasons; position must still win.
// ---------------------------------------------------------------------------

describe("CSS Modules position-based demangle — nested rule in a .module.scss", () => {
  const RELPATH = "src/Panel.module.scss";
  const HEADER_COLOR_LINE = 10; // "    color: #111111;" inside the NESTED .header
  const HEADER_COLOR_COLUMN = 4;

  function sheet(root: string): StyleSheetRef {
    return {
      id: "s1",
      sourceURL: "http://localhost:5173/src/Panel.module.scss?t=hash456",
      sourceMapURL: dataUriSourceMap(RELPATH, HEADER_COLOR_LINE, HEADER_COLOR_COLUMN),
      origin: "regular",
    };
  }

  it("a hashed + flattened selector for the nested rule lands on .header (innermost), not the outer .panel", () => {
    const { root } = makeWorkspace("css-module-nested.module.scss", RELPATH);
    const s = sheet(root);
    const target = resolveTargetForChange(root, s, { startLine: 0, startColumn: 0, endLine: 0, endColumn: 5 });
    expect(target?.kind).toBe("css");
    expect(target?.line).toBe(HEADER_COLOR_LINE);

    const source = fs.readFileSync(path.join(root, RELPATH), "utf8");
    const res = applyCssChange(
      source,
      {
        op: "modify",
        styleSheet: s,
        // Compiled selector is FLATTENED (".panel .header"), which is also
        // never the source's own nested-rule selector text (".header").
        selector: ".Panel_panel__ab12 .Panel_header__cd34",
        property: "color",
        oldValue: "#111111",
        newValue: "#ff0000",
      },
      {
        syntax: cssSyntaxForFile(RELPATH),
        position: target?.line !== null && target ? { line: target.line, column: target.column } : undefined,
      },
    );

    expect(res.css).toMatch(/\.header \{\n\s*color: #ff0000;/);
    // the OUTER .panel's own declaration (background) is untouched
    expect(res.css).toContain("background: #ffffff;");
    // font-weight, the header's OTHER declaration, is untouched
    expect(res.css).toContain("font-weight: 600;");
  });
});
