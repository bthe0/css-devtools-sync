import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as babelParse } from "@babel/parser";
import * as recast from "recast";
import type {
  ElementContext,
  RemoveAttrChange,
  SetAttrChange,
  SetTextChange,
  SetTextSegmentChange,
} from "@dev-sync/contract";
import { applyJsxChange as applyJsxChangePure, describeJsxTemplate } from "../src/apply-jsx.js";

/**
 * applyJsxChange is now PURE (it returns { file, before, after } and writes
 * nothing — the apply.ts spine decides preview vs commit). These unit tests
 * predate that split and assert against the file on disk, so this thin wrapper
 * restores the old commit-immediately behavior: compute, then persist `after`.
 * The pure function's own contract (before/after correctness) is covered by the
 * integration + preview/commit suites.
 */
function applyJsxChange(
  ...args: Parameters<typeof applyJsxChangePure>
): ReturnType<typeof applyJsxChangePure> {
  const res = applyJsxChangePure(...args);
  if (res.before !== res.after) fs.writeFileSync(res.file, res.after, "utf8");
  return res;
}
import { SkipChangeError } from "../src/errors.js";
import { WorkspaceError } from "../src/workspace.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Write `content` to <tmp>/src/App.tsx inside a fresh workspace root; returns {root, relFile, absFile}. */
function makeWorkspace(content: string): { root: string; relFile: string; absFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-jsx-"));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const relFile = "src/App.tsx";
  const absFile = path.join(root, relFile);
  fs.writeFileSync(absFile, content, "utf8");
  return { root, relFile, absFile };
}

function element(relFile: string, line: number, extra: Partial<ElementContext> = {}): ElementContext & {
  dataSourceFile: string;
  dataSourceLine: number;
} {
  return {
    tagName: "div",
    classList: [],
    dataSourceFile: relFile,
    dataSourceLine: line,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// set-attr — happy paths
// ---------------------------------------------------------------------------

describe("applyJsxChange — set-attr", () => {
  it("adds a new attribute containing a double quote as a JSXExpressionContainer, and the result re-parses cleanly", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "title",
      value: 'say "hi"',
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('title={"say \\"hi\\""}');
    // must actually re-parse — this is the core invariant under test
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("updates an EXISTING string-literal attribute to a quote-containing value via JSXExpressionContainer, and re-parses cleanly", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card" title="old">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "title",
      value: 'say "hi"',
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('title={"say \\"hi\\""}');
    expect(out).not.toContain('title="old"');
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("skips (SkipChangeError, file untouched) for a malformed attribute name instead of writing broken JSX", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "1-not valid!",
      value: "x",
    };
    expect(() => applyJsxChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyJsxChange(root, change)).toThrow(/invalid attribute name/);
    // file must be byte-identical — never partially written
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("adds a new attribute as a string literal when absent", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "title",
      value: "hello there",
    };
    const res = applyJsxChange(root, change);
    expect(res.file).toBe(fs.realpathSync(absFile));
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('title="hello there"');
    expect(out).toContain('className="card"');
  });

  it("updates an existing string-literal attribute", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card" title="old">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "title",
      value: "new",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('title="new"');
    expect(out).not.toContain('title="old"');
  });

  it("updates a boolean-shorthand attribute to a valued string literal", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <input disabled />\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3, { tagName: "input" }),
      attribute: "disabled",
      value: "true",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('disabled="true"');
  });

  it("style: updates a string-form style attribute", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div style="color: red;">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "style",
      value: "color: blue; font-size: 12px",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('style="color: blue; font-size: 12px"');
  });

  it("style: rewrites an object-form style attribute, camelCasing property names", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div style={{ color: "red" }}>\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "style",
      value: "color: blue; font-size: 12px; --my-var: 3",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('color: "blue"');
    expect(out).toContain('fontSize: "12px"');
    expect(out).toContain('"--my-var": "3"');
  });
});

// ---------------------------------------------------------------------------
// set-attr — SKIP reasons
// ---------------------------------------------------------------------------

describe("applyJsxChange — set-attr SKIP reasons", () => {
  it("skips when the existing attribute value is a JSX expression", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  const y = "dynamic";\n  return (\n    <div data-x={y}>\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 4),
      attribute: "data-x",
      value: "static",
    };
    expect(() => applyJsxChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyJsxChange(root, change)).toThrow(/JSX expression/);
  });

  it("skips style when there is no existing style attribute (ambiguous string-vs-object form)", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "style",
      value: "color: red",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/ambiguous/);
  });

  it("skips style object rewrite when the object contains a spread", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  const base = {};\n  return (\n    <div style={{ ...base, color: "red" }}>\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 4),
      attribute: "style",
      value: "color: blue",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/spread/);
  });

  it("skips style object rewrite when the new value fails to parse as CSS declarations", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div style={{ color: "red" }}>\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "style",
      value: "not valid css at all",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/could not be parsed/);
  });

  it("skips style when the existing value is a dynamic (non-object) expression", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  const s = getStyle();\n  return (\n    <div style={s}>\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 4),
      attribute: "style",
      value: "color: red",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/dynamic expression/);
  });

  // class/className must NEVER be written as a raw attribute here — that is the
  // class-list tier's job, and a stray chrome.debugger re-render event once
  // produced a phantom set-attr on `class` that duplicated the attribute. Guard
  // it at the writer so no source (poller OR legacy SW) can corrupt the element.
  it.each(["class", "className"])("skips set-attr on %s (class-list tier owns it)", (attr) => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: attr,
      value: "card danger",
    };
    expect(() => applyJsxChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyJsxChange(root, change)).toThrow(/class-list tier/);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before); // file untouched
  });
});

// ---------------------------------------------------------------------------
// remove-attr
// ---------------------------------------------------------------------------

describe("applyJsxChange — remove-attr", () => {
  it("removes an attribute that is present", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card" title="hi">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: RemoveAttrChange = {
      op: "remove-attr",
      element: element(relFile, 3),
      attribute: "title",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).not.toContain("title=");
    expect(out).toContain('className="card"');
  });

  it("skips (does not throw a non-Skip error) when the attribute is not present", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: RemoveAttrChange = {
      op: "remove-attr",
      element: element(relFile, 3),
      attribute: "title",
    };
    expect(() => applyJsxChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyJsxChange(root, change)).toThrow(/not present/);
  });
});

// ---------------------------------------------------------------------------
// set-text
// ---------------------------------------------------------------------------

describe("applyJsxChange — set-text", () => {
  it("encodes text containing <, {, } as a JSXExpressionContainer string literal, and the result re-parses cleanly", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 3),
      newText: "price < 5 and {cheap}",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('{"price < 5 and {cheap}"}');
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("encodes text containing <, {, } into an EMPTY element the same way, and re-parses cleanly", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card"></div>\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 3),
      newText: "a > b { thing }",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('{"a > b { thing }"}');
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("replaces a single JSXText child", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 3),
      newText: "Goodbye",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain("Goodbye");
    expect(out).not.toContain("Hello");
  });

  it("inserts text into an element with no children", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card"></div>\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 3),
      newText: "New text",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain("New text");
  });

  it("skips when the element is self-closing", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return (\n    <img src="a.png" />\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 3, { tagName: "img" }),
      newText: "New text",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/self-closing/);
  });

  it("skips when children contain an expression (dynamic content)", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  const cond = true;\n  return (\n    <div>{cond ? "a" : "b"}</div>\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 4),
      newText: "New text",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/expressions or nested elements/);
  });

  it("skips when children mix text and a nested element", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div>\n      Hello <b>world</b>\n    </div>\n  );\n}\n`,
    );
    const change: SetTextChange = {
      op: "set-text",
      element: element(relFile, 3),
      newText: "New text",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/expressions or nested elements/);
  });
});

// ---------------------------------------------------------------------------
// describe template — enumerate an element's source children
// ---------------------------------------------------------------------------

describe("describeJsxTemplate", () => {
  it("splits a mixed element into static runs and a dynamic hole, in order", () => {
    const { root, relFile, absFile } = makeWorkspace(
      `export function App({ name }) {\n  return (\n    <p>Hello {name}!</p>\n  );\n}\n`,
    );
    const desc = describeJsxTemplate(root, element(relFile, 3, { tagName: "p" }));
    expect(desc.file).toBe(fs.realpathSync(absFile));
    expect(desc.line).toBe(3);
    expect(desc.tag).toBe("p");
    expect(desc.editable).toBe(true);
    expect(desc.parts).toEqual([
      { kind: "static", index: 0, text: "Hello ", whitespaceOnly: false },
      { kind: "dynamic", index: 1, expr: "name" },
      { kind: "static", index: 2, text: "!", whitespaceOnly: false },
    ]);
  });

  it("flags whitespace-only static segments and classifies nested elements", () => {
    const { root, relFile } = makeWorkspace(
      `export function App({ n }) {\n  return (\n    <div>\n      {n} <b>x</b>\n    </div>\n  );\n}\n`,
    );
    const desc = describeJsxTemplate(root, element(relFile, 3));
    const kinds = desc.parts.map((p) => p.kind);
    // leading indent (static ws) -> dynamic {n} -> " " (static ws) -> <b> element -> trailing indent (static ws)
    expect(kinds).toEqual(["static", "dynamic", "static", "element", "static"]);
    const elementPart = desc.parts.find((p) => p.kind === "element");
    expect(elementPart).toMatchObject({ kind: "element", tag: "b" });
    // every static part here is whitespace-only -> nothing editable
    expect(desc.parts.filter((p) => p.kind === "static").every((p) => p.kind === "static" && p.whitespaceOnly)).toBe(true);
    expect(desc.editable).toBe(false);
  });

  it("throws SkipChangeError when no element is at the source line", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return <div>x</div>;\n}\n`,
    );
    expect(() => describeJsxTemplate(root, element(relFile, 99))).toThrow(SkipChangeError);
  });

  it("rejects a path that escapes the workspace jail", () => {
    const { root } = makeWorkspace(`export const x = 1;\n`);
    expect(() =>
      describeJsxTemplate(root, element("../../etc/passwd", 1)),
    ).toThrow(WorkspaceError);
  });
});

// ---------------------------------------------------------------------------
// set-text-segment — edit ONE static run, leave dynamic holes intact
// ---------------------------------------------------------------------------

describe("applyJsxChange — set-text-segment", () => {
  const MIXED = `export function App({ name }) {\n  return (\n    <p>Hello {name}!</p>\n  );\n}\n`;

  it("edits one static run and leaves the {expression} untouched", () => {
    const { root, relFile, absFile } = makeWorkspace(MIXED);
    const change: SetTextSegmentChange = {
      op: "set-text-segment",
      element: element(relFile, 3, { tagName: "p" }),
      segmentIndex: 0,
      oldText: "Hello ",
      newText: "Hi ",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain("<p>Hi {name}!</p>");
    expect(out).toContain("{name}"); // dynamic hole preserved
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("round-trips through describe: the reported index+text feed straight back", () => {
    const { root, relFile, absFile } = makeWorkspace(MIXED);
    const el = element(relFile, 3, { tagName: "p" });
    const desc = describeJsxTemplate(root, el);
    const last = desc.parts.find((p) => p.kind === "static" && p.text === "!");
    expect(last).toBeDefined();
    if (last?.kind !== "static") throw new Error("expected static part");
    applyJsxChange(root, {
      op: "set-text-segment",
      element: el,
      segmentIndex: last.index,
      oldText: last.text,
      newText: "?",
    });
    expect(fs.readFileSync(absFile, "utf8")).toContain("<p>Hello {name}?</p>");
  });

  it("escapes JSX-unsafe replacement text into a {\"...\"} container, holes intact", () => {
    const { root, relFile, absFile } = makeWorkspace(MIXED);
    applyJsxChange(root, {
      op: "set-text-segment",
      element: element(relFile, 3, { tagName: "p" }),
      segmentIndex: 0,
      oldText: "Hello ",
      newText: "a < b {x} ",
    });
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('{"a < b {x} "}');
    expect(out).toContain("{name}");
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("skips (file untouched) when oldText no longer matches the segment (drift guard)", () => {
    const { root, relFile, absFile } = makeWorkspace(MIXED);
    const before = fs.readFileSync(absFile, "utf8");
    const change: SetTextSegmentChange = {
      op: "set-text-segment",
      element: element(relFile, 3, { tagName: "p" }),
      segmentIndex: 0,
      oldText: "STALE",
      newText: "Hi ",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/source drift/);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("skips when the index points at a dynamic (non-JSXText) child", () => {
    const { root, relFile, absFile } = makeWorkspace(MIXED);
    const before = fs.readFileSync(absFile, "utf8");
    const change: SetTextSegmentChange = {
      op: "set-text-segment",
      element: element(relFile, 3, { tagName: "p" }),
      segmentIndex: 1, // the {name} hole
      oldText: "name",
      newText: "evil",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/not editable static text/);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });

  it("preserves a leading space and surrounding formatting when the element is wrapped in a multi-line return (regression: recast whole-element reprint dropped the space)", () => {
    // The multi-line `return (\n ... \n )` wrapper used to trigger a recast
    // reprint that BOTH collapsed the wrapper AND dropped the leading space of
    // the replacement, silently persisting " unread!" as "unread!".
    const { root, relFile, absFile } = makeWorkspace(
      `export function G({ name, count }) {\n  return (\n    <p className="greeting">Hello {name}, you have {count} messages!</p>\n  );\n}\n`,
    );
    const before = fs.readFileSync(absFile, "utf8");
    applyJsxChange(root, {
      op: "set-text-segment",
      element: element(relFile, 3, { tagName: "p" }),
      segmentIndex: 4, // " messages!"
      oldText: " messages!",
      newText: " unread!",
    });
    const out = fs.readFileSync(absFile, "utf8");
    // exact value fidelity: the leading space survives
    expect(out).toContain("{count} unread!");
    expect(out).not.toContain("{count}unread!");
    // everything else is byte-for-byte identical (no reflow of the wrapper)
    expect(out).toBe(before.replace(" messages!", " unread!"));
    expect(out).toContain("{name}"); // dynamic holes intact
    expect(() =>
      babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });

  it("skips when the segment index is out of range", () => {
    const { root, relFile, absFile } = makeWorkspace(MIXED);
    const before = fs.readFileSync(absFile, "utf8");
    const change: SetTextSegmentChange = {
      op: "set-text-segment",
      element: element(relFile, 3, { tagName: "p" }),
      segmentIndex: 99,
      oldText: "Hello ",
      newText: "Hi ",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/no child at index/);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Locating the element robustly
// ---------------------------------------------------------------------------

describe("applyJsxChange — element location", () => {
  it("falls back to the nearest enclosing element when nothing starts exactly on the target line", () => {
    const { root, relFile, absFile } = makeWorkspace(
      [
        "export function Comp() {",
        "  return (",
        "    <button",
        '      type="button"',
        '      className="btn"',
        "    >",
        "      Click",
        "    </button>",
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    // line 5 is inside the multi-line opening tag; no element STARTS there.
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 5, { tagName: "button" }),
      attribute: "title",
      value: "click me",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(out).toContain('title="click me"');
  });

  it("skips with a clear reason when no element encloses the target line", () => {
    const { root, relFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 999),
      attribute: "title",
      value: "x",
    };
    expect(() => applyJsxChange(root, change)).toThrow(/no JSX element found/);
  });
});

// ---------------------------------------------------------------------------
// File resolution failures
// ---------------------------------------------------------------------------

describe("applyJsxChange — file resolution", () => {
  it("skips with a reason when the instrumented source file does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-jsx-"));
    tmpDirs.push(root);
    const change: SetAttrChange = {
      op: "set-attr",
      element: element("src/Missing.tsx", 3),
      attribute: "title",
      value: "x",
    };
    expect(() => applyJsxChange(root, change)).toThrow(SkipChangeError);
    expect(() => applyJsxChange(root, change)).toThrow(/not found/);
  });

  it("throws SkipChangeError (not a crash) when the source fails to parse", () => {
    const { root, relFile } = makeWorkspace("this is not { valid js at all (((");
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 1),
      attribute: "title",
      value: "x",
    };
    expect(() => applyJsxChange(root, change)).toThrow(SkipChangeError);
  });

  it("rejects an absolute dataSourceFile via jailResolve (never bypassed)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-jsx-"));
    tmpDirs.push(root);
    const change: SetAttrChange = {
      op: "set-attr",
      element: element("/etc/passwd", 1),
      attribute: "title",
      value: "x",
    };
    expect(() => applyJsxChange(root, change)).toThrow(WorkspaceError);
  });

  it("rejects a traversal dataSourceFile via jailResolve (never bypassed)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-jsx-"));
    tmpDirs.push(root);
    const change: SetAttrChange = {
      op: "set-attr",
      element: element("../../etc/passwd", 1),
      attribute: "title",
      value: "x",
    };
    expect(() => applyJsxChange(root, change)).toThrow(WorkspaceError);
  });
});

// ---------------------------------------------------------------------------
// Value fidelity: EXACT round-trip (not just re-parseability)
//
// A value can round-trip to something DIFFERENT yet still parse cleanly —
// re-parse alone does not catch that. Every case below either (a) persists
// a value that reads back byte-for-byte identical to what was requested, or
// (b) is skipped with a reason and leaves the file byte-identical. Never a
// silent value change.
// ---------------------------------------------------------------------------

/** Read back the string value of `attribute` on the first JSX element in `source`, resolving both forms this module ever writes (bare string literal, or a {"..."} expression container). Throws if the attribute isn't found in one of those two forms. */
function readBackAttrValue(source: string, attribute: string): string {
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
  if (found === undefined) throw new Error(`attribute "${attribute}" not found in a recognized string form`);
  return found;
}

/** Read back the sole JSXText/expression-container text child of the first JSX element in `source`. */
function readBackTextValue(source: string): string {
  const ast = babelParse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  let found: string | undefined;
  recast.types.visit(ast, {
    visitJSXElement(p) {
      const children = p.node.children as Array<{
        type?: string;
        value?: unknown;
        expression?: { type?: string; value?: unknown };
      }>;
      if (children.length === 1) {
        const c = children[0];
        if (c?.type === "JSXText") found = String(c.value);
        else if (c?.type === "JSXExpressionContainer" && c.expression?.type === "StringLiteral") {
          found = String(c.expression.value);
        }
      }
      return false;
    },
  });
  if (found === undefined) throw new Error("text child not found in a recognized form");
  return found;
}

describe("applyJsxChange — value fidelity (exact round-trip, not just re-parseability)", () => {
  const TRICKY_VALUES = [
    ["backslash", "back\\slash"],
    ["newline", "line one\nline two"],
    ["tab", "col1\tcol2"],
    ["CR", "before\rafter"],
    ["backtick", "back`tick`s"],
    ["angle brackets", "a < b > c"],
  ] as const;

  describe.each(TRICKY_VALUES)("set-attr with a %s value", (_label, value) => {
    it("persists a value that reads back EXACTLY identical, or is skipped with the file left byte-identical", () => {
      const { root, relFile, absFile } = makeWorkspace(
        `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
      );
      const before = fs.readFileSync(absFile, "utf8");
      const change: SetAttrChange = {
        op: "set-attr",
        element: element(relFile, 3),
        attribute: "title",
        value,
      };
      try {
        applyJsxChange(root, change);
      } catch (err) {
        expect(err).toBeInstanceOf(SkipChangeError);
        expect(fs.readFileSync(absFile, "utf8")).toBe(before);
        return;
      }
      const out = fs.readFileSync(absFile, "utf8");
      expect(readBackAttrValue(out, "title")).toBe(value);
      // and it must still be valid JSX, full stop
      expect(() =>
        babelParse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
      ).not.toThrow();
    });

    it("updating an EXISTING string-literal attribute also round-trips exactly, or skips leaving the file byte-identical", () => {
      const { root, relFile, absFile } = makeWorkspace(
        `export function App() {\n  return (\n    <div className="card" title="old">\n      Hello\n    </div>\n  );\n}\n`,
      );
      const before = fs.readFileSync(absFile, "utf8");
      const change: SetAttrChange = {
        op: "set-attr",
        element: element(relFile, 3),
        attribute: "title",
        value,
      };
      try {
        applyJsxChange(root, change);
      } catch (err) {
        expect(err).toBeInstanceOf(SkipChangeError);
        expect(fs.readFileSync(absFile, "utf8")).toBe(before);
        return;
      }
      const out = fs.readFileSync(absFile, "utf8");
      expect(readBackAttrValue(out, "title")).toBe(value);
    });
  });

  it("regression: a real tab character no longer silently becomes the two literal characters backslash+t", () => {
    // This is the exact failure family both prior audits found: the bare
    // JSX-attribute-string path used to print a JS-style `\t` escape for a
    // real tab byte, which JSX's own parser then reads back as two literal
    // characters (backslash, t) — re-parses fine, wrong value.
    const { root, relFile, absFile } = makeWorkspace(
      `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
    );
    const change: SetAttrChange = {
      op: "set-attr",
      element: element(relFile, 3),
      attribute: "title",
      value: "tab\there",
    };
    applyJsxChange(root, change);
    const out = fs.readFileSync(absFile, "utf8");
    expect(readBackAttrValue(out, "title")).toBe("tab\there");
    // routed through the JSXExpressionContainer form (the fix), not a bare
    // JSX attribute string (the lossy pre-fix form — same escaped text, but
    // unwrapped, so JSX's own parser reads the backslash+t back literally)
    expect(out).toContain('title={"tab\\there"}');
    expect(out).not.toMatch(/title="tab\\there"/);
  });

  describe.each(TRICKY_VALUES)("set-text with a %s value", (_label, value) => {
    it("persists text that reads back EXACTLY identical", () => {
      const { root, relFile, absFile } = makeWorkspace(
        `export function App() {\n  return (\n    <div className="card">\n      Hello\n    </div>\n  );\n}\n`,
      );
      const before = fs.readFileSync(absFile, "utf8");
      const change: SetTextChange = {
        op: "set-text",
        element: element(relFile, 3),
        newText: value,
      };
      try {
        applyJsxChange(root, change);
      } catch (err) {
        expect(err).toBeInstanceOf(SkipChangeError);
        expect(fs.readFileSync(absFile, "utf8")).toBe(before);
        return;
      }
      const out = fs.readFileSync(absFile, "utf8");
      expect(readBackTextValue(out)).toBe(value);
    });
  });
});
