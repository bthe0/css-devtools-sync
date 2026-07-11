import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AddDeclChange, ElementContext, ModifyChange } from "@css-sync/contract";
import { applyClassListChange } from "../src/classlist.js";
import { SkipChangeError } from "../src/errors.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Write `content` to <tmp>/relFile inside a fresh workspace root; returns {root, absFile}. */
function makeWorkspace(relFile: string, content: string): { root: string; absFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-classlist-"));
  tmpDirs.push(root);
  const absFile = path.join(root, relFile);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, content, "utf8");
  return { root, absFile };
}

function element(relFile: string, line: number, extra: Partial<ElementContext> = {}): ElementContext {
  return {
    tagName: "div",
    classList: [],
    dataSourceFile: relFile,
    dataSourceLine: line,
    ...extra,
  };
}

/** An add-decl change that maps deterministically to a utility class via utilityForDeclaration. */
function addDeclChange(el: ElementContext, property: string, newValue: string): AddDeclChange {
  return {
    op: "add-decl",
    styleSheet: { id: "s1", sourceURL: "http://localhost:5173/src/index.css", origin: "regular" },
    selector: ".whatever",
    property,
    newValue,
    element: el,
  };
}

// ---------------------------------------------------------------------------
// Value fidelity: a generated utility token that cannot be safely embedded
// in a class attribute must be SKIPPED, never spliced in mangled. Tailwind
// arbitrary-value syntax has no way to express a raw quote, so skipping
// loses nothing (there is no valid alternate representation to fall back to).
// ---------------------------------------------------------------------------

describe("applyClassListChange — utility token safety (value fidelity)", () => {
  it("HTML: a quote-bearing generated token (background-image: url(\"evil.png\")) is skipped with a reason, file left byte-identical", () => {
    const relFile = "index.html";
    const { root, absFile } = makeWorkspace(
      relFile,
      `<!doctype html>\n<html>\n  <body>\n    <div class="card" data-source-line="4">Hi</div>\n  </body>\n</html>\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change = addDeclChange(element(relFile, 4), "background-image", 'url("evil.png")');

    expect(() => applyClassListChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyClassListChange(root, change)).toThrow(/cannot be safely embedded/);
    // never partially written — byte-identical to the original file
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("HTML: a quote-bearing token on an element with NO existing class attribute is also skipped, file left byte-identical", () => {
    const relFile = "index.html";
    const { root, absFile } = makeWorkspace(
      relFile,
      `<!doctype html>\n<html>\n  <body>\n    <div data-source-line="4">Hi</div>\n  </body>\n</html>\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change = addDeclChange(element(relFile, 4), "background-image", 'url("evil.png")');

    expect(() => applyClassListChange(root, change)).toThrow(SkipChangeError);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("JSX: the same quote-bearing token is ALSO skipped (Tailwind syntax can't express it there either), file left byte-identical", () => {
    const relFile = "src/App.tsx";
    const { root, absFile } = makeWorkspace(
      relFile,
      `export function App() {\n  return (\n    <div className="card">\n      Hi\n    </div>\n  );\n}\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change = addDeclChange(element(relFile, 3), "background-image", 'url("evil.png")');

    expect(() => applyClassListChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyClassListChange(root, change)).toThrow(/cannot be safely embedded/);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("JSX: a quote-bearing token on an element with NO existing className is also skipped, file left byte-identical", () => {
    const relFile = "src/App.tsx";
    const { root, absFile } = makeWorkspace(
      relFile,
      `export function App() {\n  return (\n    <div>\n      Hi\n    </div>\n  );\n}\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change = addDeclChange(element(relFile, 3), "background-image", 'url("evil.png")');

    expect(() => applyClassListChange(root, change)).toThrow(SkipChangeError);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("HTML: a safe generated token is applied normally and reads back exactly the intended class list", () => {
    const relFile = "index.html";
    const { root, absFile } = makeWorkspace(
      relFile,
      `<!doctype html>\n<html>\n  <body>\n    <div class="card" data-source-line="4">Hi</div>\n  </body>\n</html>\n`,
    );
    const change = addDeclChange(element(relFile, 4), "padding", "48px");

    const res = applyClassListChange(root, change);
    expect(res.note).toBeUndefined();
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('class="card p-[48px]"');
  });

  it("JSX: a safe generated token is applied normally and reads back exactly the intended class list", () => {
    const relFile = "src/App.tsx";
    const { root, absFile } = makeWorkspace(
      relFile,
      `export function App() {\n  return (\n    <div className="card">\n      Hi\n    </div>\n  );\n}\n`,
    );
    const change = addDeclChange(element(relFile, 3), "padding", "48px");

    applyClassListChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('className="card p-[48px]"');
  });

  it("skips (not a crash) for an apostrophe-bearing generated token, file left byte-identical", () => {
    const relFile = "index.html";
    const { root, absFile } = makeWorkspace(
      relFile,
      `<!doctype html>\n<html>\n  <body>\n    <div class="card" data-source-line="4">Hi</div>\n  </body>\n</html>\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change = addDeclChange(element(relFile, 4), "font-family", "'Comic Sans MS'");

    expect(() => applyClassListChange(root, change)).toThrow(SkipChangeError);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("JSX: a single-line self-closing element (recast reflow risk) still applies correctly, not a false skip", () => {
    // Regression: recast can reflow/collapse the containing `return (...)`
    // onto one line when a self-closing element's attribute value is
    // replaced with a brand-new node — this shifts the printed line number
    // out from under any relocate-by-line fidelity check. The fix scopes
    // the fidelity check to the built node itself, not a full-document
    // reparse + relocate, so this must NOT be skipped.
    const relFile = "src/App.tsx";
    const { root, absFile } = makeWorkspace(
      relFile,
      `export function App() {\n  return (\n    <input className="card" />\n  );\n}\n`,
    );
    const change = addDeclChange(element(relFile, 3, { tagName: "input" }), "padding", "48px");

    const res = applyClassListChange(root, change);
    expect(res.note).toBeUndefined();
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('className="card p-[48px]"');
  });
});

// ---------------------------------------------------------------------------
// Edge case: the element ALREADY has an arbitrary-value utility class
// (p-[40px]) and DevTools sends a MODIFY changing its value again
// (-> p-[48px]). The old token must be REPLACED, never left alongside the
// new one — applyTokens' remove-then-add must key off the exact old
// arbitrary-value token DevTools reports as the modified rule's selector.
// ---------------------------------------------------------------------------

function modifyChange(el: ElementContext, selector: string, property: string, newValue: string): ModifyChange {
  return {
    op: "modify",
    styleSheet: { id: "s1", sourceURL: "http://localhost:5173/src/index.css", origin: "regular" },
    selector,
    property,
    oldValue: "40px",
    newValue,
    element: el,
  };
}

describe("applyClassListChange — modify an element that ALREADY has an arbitrary-value class", () => {
  it("HTML: p-[40px] -> p-[48px] REPLACES the old arbitrary-value token, does not duplicate it", () => {
    const relFile = "index.html";
    const { root, absFile } = makeWorkspace(
      relFile,
      `<!doctype html>\n<html>\n  <body>\n    <div class="card p-[40px]" data-source-line="4">Hi</div>\n  </body>\n</html>\n`,
    );
    // DevTools reports the CURRENT arbitrary-value selector being edited —
    // escaped exactly as Tailwind's own generated CSS selector would be.
    const change = modifyChange(element(relFile, 4), ".p-\\[40px\\]", "padding", "48px");

    const res = applyClassListChange(root, change);
    expect(res.note).toBeUndefined();
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('class="card p-[48px]"');
    expect(out).not.toContain("p-[40px]");
    // exactly one padding utility token — no duplicate left behind
    expect(out.match(/p-\[\d+px\]/g)?.length).toBe(1);
  });

  it("JSX: p-[40px] -> p-[48px] REPLACES the old arbitrary-value token, does not duplicate it", () => {
    const relFile = "src/App.tsx";
    const { root, absFile } = makeWorkspace(
      relFile,
      `export function App() {\n  return (\n    <div className="card p-[40px]">\n      Hi\n    </div>\n  );\n}\n`,
    );
    const change = modifyChange(element(relFile, 3), ".p-\\[40px\\]", "padding", "48px");

    const res = applyClassListChange(root, change);
    expect(res.note).toBeUndefined();
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('className="card p-[48px]"');
    expect(out).not.toContain("p-[40px]");
    expect(out.match(/p-\[\d+px\]/g)?.length).toBe(1);
  });

  it("HTML: an arbitrary-value class with a DIFFERENT property maps to a NEW token and the old one is still removed", () => {
    const relFile = "index.html";
    const { root, absFile } = makeWorkspace(
      relFile,
      `<!doctype html>\n<html>\n  <body>\n    <div class="card mt-[10px]" data-source-line="4">Hi</div>\n  </body>\n</html>\n`,
    );
    const change = modifyChange(element(relFile, 4), ".mt-\\[10px\\]", "margin-top", "24px");

    applyClassListChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('class="card mt-[24px]"');
    expect(out).not.toContain("mt-[10px]");
  });
});
