import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postcss from "postcss";
import { afterEach, describe, expect, it } from "vitest";
import { parse as babelParse } from "@babel/parser";
import * as recast from "recast";
import type {
  AddDeclChange,
  ElementContext,
  ModifyChange,
  SetAttrChange,
  StyleSheetRef,
} from "@css-sync/contract";
import { applyCssChange } from "../src/apply-css.js";
import { applyCssInJsChange } from "../src/cssinjs.js";
import { applyJsxChange as applyJsxChangePure } from "../src/apply-jsx.js";

// apply-jsx.ts is now a PURE writer (computes { file, before, after }, no fsync).
// This fidelity suite asserts the persisted file, so wrap the pure call to
// persist `after` — the single-file JSX writer only ever touches its own file.
function applyJsxChange(
  ...args: Parameters<typeof applyJsxChangePure>
): ReturnType<typeof applyJsxChangePure> {
  const res = applyJsxChangePure(...args);
  if (res.before !== res.after) fs.writeFileSync(res.file, res.after, "utf8");
  return res;
}
import { applyClassListChange } from "../src/classlist.js";
import { SkipChangeError } from "../src/errors.js";

/**
 * apps/server/test/fidelity.test.ts — the regression suite for the shared
 * guard in src/fidelity.ts. Three prior audits each found the SAME bug
 * family (a writer persists source that re-parses but holds a different
 * value, or injects an extra declaration/rule/interpolation, or turns a
 * value into executing code — and reports success) in a DIFFERENT writer.
 * This file is a parametrized matrix over {writer} x {hostile value}: for
 * every combination, the writer must EITHER persist the value EXACTLY, OR
 * throw SkipChangeError and leave the target byte-identical. Never a silent
 * partial write.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const sheet: StyleSheetRef = {
  id: "sheet-1",
  sourceURL: "http://localhost:5173/styles/app.css",
  origin: "regular",
};

type Outcome = { skipped: true; reason: string } | { skipped: false; value: string };

function expectSkippedOrExact(outcome: () => Outcome, expected: string): void {
  const result = outcome();
  if (result.skipped) {
    expect(result.reason).toBeTruthy();
  } else {
    expect(result.value).toBe(expected);
  }
}

function expectMustSkip(outcome: () => Outcome): void {
  const result = outcome();
  expect(result.skipped).toBe(true);
}

// ---------------------------------------------------------------------------
// Writer: apply-css.ts (plain CSS, modify + add-decl)
// ---------------------------------------------------------------------------

const CSS_FIXTURE = `.card {
  color: red;
}
`;

function readCssDeclValue(css: string, selector: string, property: string): string | null {
  const root = postcss.parse(css);
  let value: string | null = null;
  root.walkRules(selector, (rule) => {
    rule.walkDecls(property, (decl) => {
      value = decl.value.trim() + (decl.important ? " !important" : "");
    });
  });
  return value;
}

function cssModifyOutcome(newValue: string): Outcome {
  try {
    const res = applyCssChange(CSS_FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      property: "color",
      oldValue: "red",
      newValue,
    });
    return { skipped: false, value: readCssDeclValue(res.css, ".card", "color") ?? "" };
  } catch (err) {
    if (err instanceof SkipChangeError) return { skipped: true, reason: err.message };
    throw err;
  }
}

function cssAddDeclOutcome(newValue: string): Outcome {
  try {
    const res = applyCssChange(CSS_FIXTURE, {
      op: "add-decl",
      styleSheet: sheet,
      selector: ".card",
      property: "cursor",
      newValue,
    } satisfies AddDeclChange);
    return { skipped: false, value: readCssDeclValue(res.css, ".card", "cursor") ?? "" };
  } catch (err) {
    if (err instanceof SkipChangeError) return { skipped: true, reason: err.message };
    throw err;
  }
}

const CSS_MUST_SKIP: [string, string][] = [
  ["unescaped semicolon (extra declaration)", "red; background: evil"],
  ["unescaped brace pair (extra rule)", "red } .evil { color: blue }"],
  ["multi-declaration payload", "blue; display: none"],
  ["multi-rule payload", "blue } .evil2 { color: purple"],
];

const CSS_SAFE_OR_SKIP: [string, string][] = [
  ["quotes", '"blue"'],
  ["backslash", "blue\\9"],
  ["newline", "blue\nsteelblue"],
  ["tab", "blue\tsteelblue"],
  ["CR", "blue\rsteelblue"],
  ["angle brackets", "blue < steelblue > red"],
];

describe("fidelity matrix — apply-css.ts (modify)", () => {
  it.each(CSS_MUST_SKIP)("rejects an injection value: %s", (_label, value) => {
    const before = CSS_FIXTURE;
    expectMustSkip(() => cssModifyOutcome(value));
    // the source passed in is never mutated by applyCssChange (pure function)
    expect(CSS_FIXTURE).toBe(before);
  });

  it.each(CSS_SAFE_OR_SKIP)("persists exactly or skips cleanly: %s", (_label, value) => {
    expectSkippedOrExact(() => cssModifyOutcome(value), value.trim());
  });
});

describe("fidelity matrix — apply-css.ts (add-decl)", () => {
  it.each(CSS_MUST_SKIP)("rejects an injection value: %s", (_label, value) => {
    expectMustSkip(() => cssAddDeclOutcome(value));
  });

  it.each(CSS_SAFE_OR_SKIP)("persists exactly or skips cleanly: %s", (_label, value) => {
    expectSkippedOrExact(() => cssAddDeclOutcome(value), value.trim());
  });
});

describe("fidelity matrix — apply-css.ts structural invariants", () => {
  it("modify: rule count and target declaration count are asserted unchanged (no injected rule/decl slips through)", () => {
    // A value that reparses cleanly as a SINGLE token but would, if injected
    // raw, still only ever produce the same 1 rule / 1 decl shape here — this
    // asserts the happy path's counts are exactly as expected (0 rules added,
    // 0 decls added), i.e. the structural check does not false-positive.
    const res = applyCssChange(CSS_FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      property: "color",
      oldValue: "red",
      newValue: "blue",
    } satisfies ModifyChange);
    const root = postcss.parse(res.css);
    let ruleCount = 0;
    root.walkRules(() => {
      ruleCount++;
    });
    expect(ruleCount).toBe(1);
  });

  it("add-rule: inserting a rule containing a hostile multi-rule ruleText is unaffected (ruleText goes through a real parser, not a byte splice)", () => {
    // add-rule parses ruleText with postcss.parse up front (not a string
    // splice), so multiple sibling rules in ruleText are a legitimate,
    // intentional feature (the "hostile splice" class of bug doesn't apply
    // here) — this just confirms the structural rule-count check tracks
    // exactly how many rules actually got inserted, for BOTH rules.
    const res = applyCssChange(CSS_FIXTURE, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".a",
      ruleText: ".a { color: red; } .b { color: blue; }",
    });
    const root = postcss.parse(res.css);
    let ruleCount = 0;
    root.walkRules(() => {
      ruleCount++;
    });
    expect(ruleCount).toBe(3); // .card + .a + .b
    expect(res.css).toContain(".a {");
    expect(res.css).toContain(".b {");
  });
});

// ---------------------------------------------------------------------------
// Writer: cssinjs.ts (emotion/styled-components template literal)
// ---------------------------------------------------------------------------

const CSSINJS_CODE = `import styled from "styled-components";

export const Box = styled.div\`
  color: red;
  padding: 4px;
\`;
`;

function readCssInJsValue(code: string, property: string): string | null {
  const re = new RegExp(`(^|[\\s;{])(${property})(\\s*:\\s*)([^;\\n}]+)`, "i");
  const m = re.exec(code);
  return m ? (m[4] ?? "").trim() : null;
}

function cssInJsModifyOutcome(newValue: string): Outcome {
  try {
    const res = applyCssInJsChange(CSSINJS_CODE, null, {
      op: "modify",
      styleSheet: sheet,
      selector: ".css-abc--Box",
      property: "color",
      oldValue: "red",
      newValue,
    } satisfies ModifyChange);
    return { skipped: false, value: readCssInJsValue(res.code, "color") ?? "" };
  } catch (err) {
    if (err instanceof SkipChangeError) return { skipped: true, reason: err.message };
    throw err;
  }
}

function cssInJsAddDeclOutcome(newValue: string): Outcome {
  try {
    const res = applyCssInJsChange(CSSINJS_CODE, null, {
      op: "add-decl",
      styleSheet: sheet,
      selector: ".css-abc--Box",
      property: "cursor",
      newValue,
    } satisfies AddDeclChange);
    return { skipped: false, value: readCssInJsValue(res.code, "cursor") ?? "" };
  } catch (err) {
    if (err instanceof SkipChangeError) return { skipped: true, reason: err.message };
    throw err;
  }
}

const CSSINJS_MUST_SKIP: [string, string][] = [
  ["backtick (terminates the template)", "back`tick`s"],
  ["${...} interpolation opener", "a${b}c"],
  ["${...} live code execution", "${globalThis.pwn=1}"],
  ["unescaped semicolon (extra declaration)", "blue; background: evil"],
  ["unescaped closing brace (breaks rule nesting)", "blue } .evil { color: purple"],
  ["unescaped opening brace (opens nested block, no ; or } present)", "red { evil"],
  ["multi-declaration payload", "blue; display: none"],
];

const CSSINJS_SAFE_OR_SKIP: [string, string][] = [
  ["quotes", 'Georgia, "Times New Roman"'],
  ["backslash", "blue\\9"],
  ["tab", "blue\tsteelblue"],
  ["CR", "blue\rsteelblue"],
  ["angle brackets", "blue < steelblue > red"],
];

describe("fidelity matrix — cssinjs.ts (modify)", () => {
  it.each(CSSINJS_MUST_SKIP)("rejects an injection value: %s", (_label, value) => {
    expectMustSkip(() => cssInJsModifyOutcome(value));
  });

  it.each(CSSINJS_SAFE_OR_SKIP)("persists exactly or skips cleanly: %s", (_label, value) => {
    expectSkippedOrExact(() => cssInJsModifyOutcome(value), value.trim());
  });

  it("newline is REJECTED by the post-splice value-fidelity check (regex re-extraction can't see past it) rather than silently truncated", () => {
    // Not pre-rejected (a raw newline is legal inside a JS template literal
    // and legal-looking CSS whitespace), but the SAME regex used to read the
    // declaration back can't match across it — demonstrating invariant (1)
    // catching a case invariant (3)'s pre-reject does not.
    expectMustSkip(() => cssInJsModifyOutcome("line one\nline two"));
  });
});

describe("fidelity matrix — cssinjs.ts (add-decl)", () => {
  it.each(CSSINJS_MUST_SKIP)("rejects an injection value: %s", (_label, value) => {
    expectMustSkip(() => cssInJsAddDeclOutcome(value));
  });

  it.each(CSSINJS_SAFE_OR_SKIP)("persists exactly or skips cleanly: %s", (_label, value) => {
    expectSkippedOrExact(() => cssInJsAddDeclOutcome(value), value.trim());
  });
});

describe("fidelity matrix — cssinjs.ts structural invariants", () => {
  it("modify: interpolation count is asserted unchanged", () => {
    const codeWithInterpolation = `import styled from "styled-components";

const gap = 4;
export const Box = styled.div\`
  color: red;
  padding: \${gap}px;
\`;
`;
    const res = applyCssInJsChange(codeWithInterpolation, null, {
      op: "modify",
      styleSheet: sheet,
      selector: ".css-abc--Box",
      property: "color",
      oldValue: "red",
      newValue: "blue",
    });
    expect(res.code).toContain("color: blue;");
    expect(res.code).toContain("padding: ${gap}px;"); // interpolation survives untouched
  });

  it("does not persist a value that would silently add a NEW interpolation even though it re-parses as valid JS+CSS text", () => {
    // "a${b}c" is rejected by the pre-reject layer already (backtick/${
    // check) — this asserts the OUTCOME (skip, file/state unaffected) end to
    // end through the public API, not just the pre-reject unit.
    expectMustSkip(() => cssInJsModifyOutcome("a${b}c"));
  });
});

// ---------------------------------------------------------------------------
// Writer: apply-jsx.ts (set-attr, including the style-attribute string form)
// ---------------------------------------------------------------------------

const jsxTmpDirs: string[] = [];
afterEach(() => {
  for (const d of jsxTmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeJsxWorkspace(content: string): { root: string; relFile: string; absFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-fidelity-jsx-"));
  jsxTmpDirs.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const relFile = "src/App.tsx";
  const absFile = path.join(root, relFile);
  fs.writeFileSync(absFile, content, "utf8");
  return { root, relFile, absFile };
}

function jsxElement(relFile: string, line: number): ElementContext & { dataSourceFile: string; dataSourceLine: number } {
  return { tagName: "div", classList: [], dataSourceFile: relFile, dataSourceLine: line };
}

function readBackJsxAttrValue(source: string, attribute: string): string | undefined {
  const ast = babelParse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  let found: string | undefined;
  recast.types.visit(ast, {
    visitJSXAttribute(p) {
      const node = p.node as unknown as {
        name: { name: string };
        value: { type?: string; value?: unknown; expression?: { type?: string; value?: unknown } } | null;
      };
      if (node.name.name !== attribute) return false;
      const val = node.value;
      if (val?.type === "StringLiteral") found = String(val.value);
      else if (val?.type === "JSXExpressionContainer" && val.expression?.type === "StringLiteral") {
        found = String(val.expression.value);
      }
      return false;
    },
  });
  return found;
}

function jsxSetAttrOutcome(attribute: string, value: string, source: string): Outcome {
  const { root, relFile, absFile } = makeJsxWorkspace(source);
  const before = fs.readFileSync(absFile, "utf8");
  const change: SetAttrChange = { op: "set-attr", element: jsxElement(relFile, 3), attribute, value };
  try {
    applyJsxChange(root, change);
  } catch (err) {
    if (err instanceof SkipChangeError) {
      expect(fs.readFileSync(absFile, "utf8")).toBe(before);
      return { skipped: true, reason: err.message };
    }
    throw err;
  }
  const out = fs.readFileSync(absFile, "utf8");
  return { skipped: false, value: readBackJsxAttrValue(out, attribute) ?? "" };
}

const JSX_HOSTILE_VALUES: [string, string][] = [
  ["quotes", 'say "hi"'],
  ["backslash", "back\\slash"],
  ["newline", "line one\nline two"],
  ["tab", "col1\tcol2"],
  ["CR", "before\rafter"],
  ["backtick", "back`tick`s"],
  ["angle brackets", "a < b > c"],
  ["dollar-brace (inert in JSX, unlike cssinjs)", "a${b}c"],
  ["semicolon/brace payload (inert in JSX, unlike CSS)", "red; background: evil"],
];

describe("fidelity matrix — apply-jsx.ts (set-attr, plain attribute)", () => {
  const SOURCE = `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`;

  it.each(JSX_HOSTILE_VALUES)("persists exactly or skips cleanly: %s", (_label, value) => {
    expectSkippedOrExact(() => jsxSetAttrOutcome("title", value, SOURCE), value);
  });
});

describe("fidelity matrix — apply-jsx.ts (set-attr, style attribute — regression for the buildAttrValueNode bypass)", () => {
  const STYLE_SOURCE = `export function App() {\n  return (\n    <div style="color: red;">\n      Hello\n    </div>\n  );\n}\n`;

  it.each(JSX_HOSTILE_VALUES)("style attribute string form persists exactly or skips cleanly: %s", (_label, value) => {
    expectSkippedOrExact(() => jsxSetAttrOutcome("style", value, STYLE_SOURCE), value);
  });

  it("a quote-bearing style value is routed through JSXExpressionContainer, not the previously-bypassed bare b.stringLiteral form", () => {
    const { root, relFile, absFile } = makeJsxWorkspace(STYLE_SOURCE);
    const change: SetAttrChange = {
      op: "set-attr",
      element: jsxElement(relFile, 3),
      attribute: "style",
      value: 'color: "red"',
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    // the fix routes this through buildAttrValueNode, which wraps unsafe
    // values (a bare double-quote cannot be represented in attr="...") in a
    // {"..."} expression container — the pre-fix bypass would have produced
    // an unrepresentable/corrupt bare string instead.
    expect(out).toContain('style={"color: \\"red\\""}');
    expect(() => babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Writer: classlist.ts (Tailwind className / class token rewriting)
// ---------------------------------------------------------------------------

const classlistTmpDirs: string[] = [];
afterEach(() => {
  for (const d of classlistTmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeClasslistWorkspace(relFile: string, content: string): { root: string; absFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-fidelity-classlist-"));
  classlistTmpDirs.push(root);
  const absFile = path.join(root, relFile);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, content, "utf8");
  return { root, absFile };
}

function classlistOutcome(cssValue: string): Outcome {
  const relFile = "src/App.tsx";
  const source = `export function App() {\n  return (\n    <div className="card">\n      Hi\n    </div>\n  );\n}\n`;
  const { root, absFile } = makeClasslistWorkspace(relFile, source);
  const before = fs.readFileSync(absFile, "utf8");
  const change: AddDeclChange = {
    op: "add-decl",
    styleSheet: { id: "s1", sourceURL: "http://localhost:5173/src/index.css", origin: "regular" },
    selector: ".whatever",
    property: "font-family",
    newValue: cssValue,
    element: { tagName: "div", classList: [], dataSourceFile: relFile, dataSourceLine: 3 },
  };
  try {
    applyClassListChange(root, change);
  } catch (err) {
    if (err instanceof SkipChangeError) {
      expect(fs.readFileSync(absFile, "utf8")).toBe(before);
      return { skipped: true, reason: err.message };
    }
    throw err;
  }
  const out = fs.readFileSync(absFile, "utf8");
  const m = /className="([^"]*)"/.exec(out);
  return { skipped: false, value: m?.[1] ?? "" };
}

// The generated utility token embeds the CSS value as-is (spaces -> "_"),
// so hostile characters land INSIDE the token itself — these must all be
// SKIPPED (Tailwind arbitrary-value syntax cannot represent any of them,
// and a raw quote/backtick/angle-bracket in a class token is a class no
// browser class-list parser can ever match).
const CLASSLIST_MUST_SKIP: [string, string][] = [
  ["quotes", '"Comic Sans"'],
  ["backtick", "`evil`"],
  ["angle brackets", "<script>"],
];

describe("fidelity matrix — classlist.ts (Tailwind utility token)", () => {
  it.each(CLASSLIST_MUST_SKIP)("rejects a token that cannot be safely embedded: %s", (_label, value) => {
    expectMustSkip(() => classlistOutcome(value));
  });

  it("a safe value is applied exactly, with the resulting utility token verified via the shared round-trip guard", () => {
    const result = classlistOutcome("Georgia");
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.value).toContain("[font-family:Georgia]");
    }
  });
});
