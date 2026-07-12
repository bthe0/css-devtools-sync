// background/diff.test.js — unit tests for the pure diff/change-building
// module. No browser, no chrome.* — this is what lets us test capture logic
// without spinning up a real tab + debugger session.
//
// Run with: node --test background/diff.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSheet,
  parseStylesheet,
  elementContextFromSrcLoc,
  hasSourceLocation,
  buildSetAttrChange,
  buildRemoveAttrChange,
  buildSetTextChange,
  buildSetTextSegmentChange,
  buildPromoteInlineStyleChange,
  promotedClassName,
  parseInlineDeclarations,
  renderProducingParts,
  reconstructRawSegment,
  resolveTextSegmentEdit,
} from "./diff.js";

const SHEET_REF = { id: "sheet-1", sourceURL: "http://localhost/app.css", origin: "regular" };

// ---------------------------------------------------------------------------
// CSS: modify
// ---------------------------------------------------------------------------

test("diffSheet: modify — existing declaration value changed", () => {
  const oldText = ".card { color: red; padding: 4px; }";
  const newText = ".card { color: blue; padding: 4px; }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    op: "modify",
    styleSheet: SHEET_REF,
    selector: ".card",
    range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 36 },
    property: "color",
    oldValue: "red",
    newValue: "blue",
  });
});

// ---------------------------------------------------------------------------
// CSS: add-decl
// ---------------------------------------------------------------------------

test("diffSheet: add-decl — new declaration on an existing rule", () => {
  const oldText = ".card { color: red; }";
  const newText = ".card { color: red; margin: 8px; }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "add-decl");
  assert.equal(changes[0].property, "margin");
  assert.equal(changes[0].newValue, "8px");
  assert.equal(changes[0].selector, ".card");
});

// ---------------------------------------------------------------------------
// CSS: delete-decl (declaration removed, and whole rule vanishing)
// ---------------------------------------------------------------------------

test("diffSheet: delete-decl — declaration removed from an existing rule", () => {
  const oldText = ".card { color: red; margin: 8px; }";
  const newText = ".card { color: red; }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.deepEqual(
    { op: changes[0].op, property: changes[0].property, selector: changes[0].selector },
    { op: "delete-decl", property: "margin", selector: ".card" },
  );
});

test("diffSheet: delete-decl — DevTools disable (comment-out) emits ONE clean delete-decl", () => {
  // Unchecking a property in the Styles pane comments it out in place; it must
  // read as a single delete of that property — never a bogus add-decl for the
  // comment text, and never swallow the following declaration.
  const oldText = ".card { color: red; margin: 8px; padding: 4px; }";
  const newText = ".card { color: red; /* margin: 8px; */ padding: 4px; }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.deepEqual(
    { op: changes[0].op, property: changes[0].property, selector: changes[0].selector },
    { op: "delete-decl", property: "margin", selector: ".card" },
  );
});

test("diffSheet: delete-decl — carries mediaText so a duplicated selector resolves", () => {
  const oldText =
    ".card { padding: 24px; }\n@media (max-width: 600px) { .card { padding: 16px; } }";
  // Disable padding INSIDE the @media block only.
  const newText =
    ".card { padding: 24px; }\n@media (max-width: 600px) { .card { /* padding: 16px; */ } }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.deepEqual(
    { op: changes[0].op, property: changes[0].property, mediaText: changes[0].mediaText },
    { op: "delete-decl", property: "padding", mediaText: "(max-width: 600px)" },
  );
});

test("diffSheet: parseDeclarations — comment token inside a quoted value survives", () => {
  const rules = parseStylesheet('.x { content: "a/*b*/c"; color: red; }');
  assert.deepEqual([...rules[0].decls], [
    ["content", '"a/*b*/c"'],
    ["color", "red"],
  ]);
});

test("diffSheet: delete-decl — whole rule removed emits one delete-decl per declaration", () => {
  const oldText = ".gone { color: red; margin: 8px; }";
  const newText = "";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.op === "delete-decl" && c.selector === ".gone"));
  assert.deepEqual(
    changes.map((c) => c.property).sort(),
    ["color", "margin"],
  );
});

// ---------------------------------------------------------------------------
// CSS: add-rule
// ---------------------------------------------------------------------------

test("diffSheet: add-rule — brand-new rule with no prior anchor", () => {
  const oldText = "";
  const newText = ".card:hover { transform: scale(1.02); }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "add-rule");
  assert.equal(changes[0].selector, ".card:hover");
  assert.equal(changes[0].ruleText, ".card:hover { transform: scale(1.02); }");
  assert.equal(changes[0].range, undefined);
});

test("diffSheet: add-rule respects @media nesting", () => {
  const oldText = "";
  const newText = "@media (max-width: 768px) { .card { padding: 2px; } }";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "add-rule");
  assert.equal(changes[0].mediaText, "(max-width: 768px)");
  assert.equal(changes[0].selector, ".card");
});

test("parseStylesheet: flattens nested rules with mediaText, ignores comments/@import", () => {
  const rules = parseStylesheet(
    '@import url("x.css");\n/* comment */\n.a { color: red; }\n@media (min-width: 10px) { .b { color: blue; } }',
  );
  assert.equal(rules.length, 2);
  assert.equal(rules[0].selector, ".a");
  assert.equal(rules[0].mediaText, undefined);
  assert.equal(rules[1].selector, ".b");
  assert.equal(rules[1].mediaText, "(min-width: 10px)");
});

// ---------------------------------------------------------------------------
// DOM: set-attr
// ---------------------------------------------------------------------------

const INSTRUMENTED_SRCLOC = {
  dataSourceFile: "src/components/Card.jsx",
  dataSourceLine: 42,
  dataSourceComponent: "Card",
};

test("buildSetAttrChange: instrumented element -> set-attr CaptureChange", () => {
  const ctx = elementContextFromSrcLoc("DIV", ["card", "active"], INSTRUMENTED_SRCLOC);
  const result = buildSetAttrChange(ctx, "aria-label", "Close dialog");

  assert.equal(result.ok, true);
  assert.deepEqual(result.change, {
    op: "set-attr",
    element: ctx,
    attribute: "aria-label",
    value: "Close dialog",
  });
});

// ---------------------------------------------------------------------------
// DOM: remove-attr
// ---------------------------------------------------------------------------

test("buildRemoveAttrChange: instrumented element -> remove-attr CaptureChange", () => {
  const ctx = elementContextFromSrcLoc("DIV", ["card", "active"], INSTRUMENTED_SRCLOC);
  const result = buildRemoveAttrChange(ctx, "aria-hidden");

  assert.equal(result.ok, true);
  assert.deepEqual(result.change, {
    op: "remove-attr",
    element: ctx,
    attribute: "aria-hidden",
  });
});

// ---------------------------------------------------------------------------
// DOM: set-text
// ---------------------------------------------------------------------------

test("buildSetTextChange: instrumented element -> set-text CaptureChange with oldText", () => {
  const ctx = elementContextFromSrcLoc("SPAN", ["card", "active"], INSTRUMENTED_SRCLOC);
  const result = buildSetTextChange(ctx, "New label", "Old label");

  assert.equal(result.ok, true);
  assert.deepEqual(result.change, {
    op: "set-text",
    element: ctx,
    newText: "New label",
    oldText: "Old label",
  });
});

test("buildSetTextChange: omits oldText when not provided (unknown prior value)", () => {
  const ctx = elementContextFromSrcLoc("SPAN", ["card", "active"], INSTRUMENTED_SRCLOC);
  const result = buildSetTextChange(ctx, "New label", undefined);

  assert.equal(result.ok, true);
  assert.equal("oldText" in result.change, false);
});

// ---------------------------------------------------------------------------
// DOM: no-source-location skip (covers set-attr, remove-attr, set-text)
// ---------------------------------------------------------------------------

test("buildSetAttrChange: element with no dataSourceFile is skipped, not silently dropped", () => {
  const ctx = elementContextFromSrcLoc("DIV", ["card"], null);
  const result = buildSetAttrChange(ctx, "aria-label", "Close");

  assert.equal(result.ok, false);
  assert.match(result.reason, /set-attr/);
  assert.match(result.reason, /data-source-file/);
  assert.match(result.reason, /not instrumented/);
});

test("buildRemoveAttrChange: element with no dataSourceLine is skipped", () => {
  // dataSourceFile present but no dataSourceLine -> still not locatable.
  const ctx = elementContextFromSrcLoc("DIV", ["card"], { dataSourceFile: "x.jsx" });
  const result = buildRemoveAttrChange(ctx, "disabled");

  assert.equal(result.ok, false);
  assert.match(result.reason, /remove-attr/);
});

test("buildSetTextChange: uninstrumented element is skipped", () => {
  const ctx = elementContextFromSrcLoc("SPAN", [], null);
  const result = buildSetTextChange(ctx, "hi", "bye");

  assert.equal(result.ok, false);
  assert.match(result.reason, /set-text/);
});

// ---------------------------------------------------------------------------
// elementContextFromSrcLoc — off-DOM __srcLoc property path
// ---------------------------------------------------------------------------

test("elementContextFromSrcLoc: builds context from a __srcLoc object + classList", () => {
  const ctx = elementContextFromSrcLoc(
    "DIV",
    ["card", "active"],
    { dataSourceFile: "src/components/Card.tsx", dataSourceLine: 42, dataSourceComponent: "Card" },
  );
  assert.deepEqual(ctx, {
    tagName: "div",
    classList: ["card", "active"],
    dataSourceFile: "src/components/Card.tsx",
    dataSourceLine: 42,
    dataSourceComponent: "Card",
  });
});

test("elementContextFromSrcLoc: null srcLoc yields a locationless (skippable) context", () => {
  const ctx = elementContextFromSrcLoc("SPAN", ["icon"], null);
  assert.deepEqual(ctx, { tagName: "span", classList: ["icon"] });
  assert.equal(hasSourceLocation(ctx), false);
});

test("elementContextFromSrcLoc: omits component when absent, tolerates empty classList", () => {
  const ctx = elementContextFromSrcLoc("BUTTON", [], {
    dataSourceFile: "x.tsx",
    dataSourceLine: 3,
  });
  assert.deepEqual(ctx, { tagName: "button", classList: [], dataSourceFile: "x.tsx", dataSourceLine: 3 });
  assert.equal(hasSourceLocation(ctx), true);
});

test("elementContextFromSrcLoc: rejects a non-positive line (no partial source location)", () => {
  const ctx = elementContextFromSrcLoc("DIV", ["c"], { dataSourceFile: "x.tsx", dataSourceLine: 0 });
  assert.equal("dataSourceLine" in ctx, false);
  assert.equal(hasSourceLocation(ctx), false);
});

test("hasSourceLocation: rejects zero/negative/non-integer line numbers", () => {
  assert.equal(hasSourceLocation({ dataSourceFile: "a.jsx", dataSourceLine: 0 }), false);
  assert.equal(hasSourceLocation({ dataSourceFile: "a.jsx", dataSourceLine: -1 }), false);
  assert.equal(hasSourceLocation({ dataSourceFile: "a.jsx", dataSourceLine: 1.5 }), false);
  assert.equal(hasSourceLocation({ dataSourceFile: "", dataSourceLine: 10 }), false);
  assert.equal(hasSourceLocation({ dataSourceFile: "a.jsx", dataSourceLine: 10 }), true);
});

// ---------------------------------------------------------------------------
// Inline-style promote: className hash, decl parse, change building
// ---------------------------------------------------------------------------

test("promotedClassName: deterministic, matches the contract charset, varies by location", () => {
  const a = promotedClassName("src/components/PlainCard.tsx", 12);
  const b = promotedClassName("src/components/PlainCard.tsx", 12);
  assert.equal(a, b, "same (file,line) -> same class");
  assert.match(a, /^csync-[0-9a-z]+$/, "matches PromotedClassNameSchema charset");

  // Different line or file -> (practically) different class.
  assert.notEqual(a, promotedClassName("src/components/PlainCard.tsx", 13));
  assert.notEqual(a, promotedClassName("src/components/Other.tsx", 12));
});

test("parseInlineDeclarations: parses cssText into ordered {property,value}[], lowercased props", () => {
  const decls = parseInlineDeclarations("color: red; Max-Width: 420px; padding: 8px 12px;");
  assert.deepEqual(decls, [
    { property: "color", value: "red" },
    { property: "max-width", value: "420px" },
    { property: "padding", value: "8px 12px" },
  ]);
});

test("parseInlineDeclarations: last write wins per property; empty/blank -> []", () => {
  assert.deepEqual(parseInlineDeclarations("color: red; color: blue"), [
    { property: "color", value: "blue" },
  ]);
  assert.deepEqual(parseInlineDeclarations(""), []);
  assert.deepEqual(parseInlineDeclarations("   "), []);
});

test("parseInlineDeclarations: preserves function values with internal semicolons/commas", () => {
  const decls = parseInlineDeclarations("background: linear-gradient(90deg, #fff, #000); color: red");
  assert.deepEqual(decls, [
    { property: "background", value: "linear-gradient(90deg, #fff, #000)" },
    { property: "color", value: "red" },
  ]);
});

test("buildPromoteInlineStyleChange: builds a valid change with generated class + full decl set", () => {
  const context = {
    tagName: "strong",
    classList: [],
    dataSourceFile: "src/components/StaticBlock.tsx",
    dataSourceLine: 25,
    dataSourceComponent: "StaticBlock",
  };
  const res = buildPromoteInlineStyleChange(context, "color: #ff0000; font-size: 14px");
  assert.equal(res.ok, true);
  assert.equal(res.change.op, "promote-inline-style");
  assert.equal(res.change.className, promotedClassName(context.dataSourceFile, context.dataSourceLine));
  assert.equal(res.change.element, context);
  assert.deepEqual(res.change.declarations, [
    { property: "color", value: "#ff0000" },
    { property: "font-size", value: "14px" },
  ]);
});

test("buildPromoteInlineStyleChange: skips when the element has no source location", () => {
  const res = buildPromoteInlineStyleChange({ tagName: "div", classList: [] }, "color: red");
  assert.equal(res.ok, false);
  assert.match(res.reason, /promote-inline-style/);
});

test("buildPromoteInlineStyleChange: skips when there are no inline declarations", () => {
  const context = {
    tagName: "div",
    classList: [],
    dataSourceFile: "a.tsx",
    dataSourceLine: 3,
  };
  const res = buildPromoteInlineStyleChange(context, "   ");
  assert.equal(res.ok, false);
  assert.match(res.reason, /no inline declarations/);
});

// ---------------------------------------------------------------------------
// Text-segment resolution (mixed static + {expr} elements)
// ---------------------------------------------------------------------------

const SEG_CONTEXT = {
  tagName: "p",
  classList: [],
  dataSourceFile: "src/Card.tsx",
  dataSourceLine: 12,
};

// Parts as the server /describe endpoint returns them for `<p>Hello {name}, {count} items</p>`.
// Children: [JSXText "Hello ", {name}, JSXText ", ", {count}, JSXText " items"].
const HELLO_PARTS = [
  { kind: "static", index: 0, text: "Hello ", whitespaceOnly: false },
  { kind: "dynamic", index: 1, expr: "name" },
  { kind: "static", index: 2, text: ", ", whitespaceOnly: false },
  { kind: "dynamic", index: 3, expr: "count" },
  { kind: "static", index: 4, text: " items", whitespaceOnly: false },
];
// Live DOM after render (name="Theo", count=5): five text nodes 1:1 with parts.
const HELLO_KIDS = [
  { t: 0, v: "Hello " },
  { t: 0, v: "Theo" },
  { t: 0, v: ", " },
  { t: 0, v: "5" },
  { t: 0, v: " items" },
];

test("renderProducingParts: drops whitespace-only static parts that contain a newline", () => {
  const parts = [
    { kind: "static", index: 0, text: "\n  ", whitespaceOnly: true }, // indentation -> no node
    { kind: "static", index: 1, text: "Hi ", whitespaceOnly: false },
    { kind: "dynamic", index: 2, expr: "x" },
    { kind: "static", index: 3, text: " ", whitespaceOnly: true }, // single space, no newline -> renders
    { kind: "static", index: 4, text: "\n", whitespaceOnly: true }, // trailing newline -> no node
  ];
  const kept = renderProducingParts(parts);
  assert.deepEqual(
    kept.map((p) => p.index),
    [1, 2, 3],
  );
});

test("resolveTextSegmentEdit: maps a static run edit to its source segmentIndex", () => {
  const res = resolveTextSegmentEdit(HELLO_PARTS, HELLO_KIDS, 0, "Hi ");
  assert.equal(res.ok, true);
  assert.equal(res.segmentIndex, 0);
  assert.equal(res.oldText, "Hello ");
  assert.equal(res.newText, "Hi ");
});

test("resolveTextSegmentEdit: edits the middle static run without touching {expr} holes", () => {
  const res = resolveTextSegmentEdit(HELLO_PARTS, HELLO_KIDS, 2, " and ");
  assert.equal(res.ok, true);
  assert.equal(res.segmentIndex, 2);
  assert.equal(res.newText, " and ");
});

test("resolveTextSegmentEdit: refuses a dynamic node (editing rendered {name})", () => {
  const res = resolveTextSegmentEdit(HELLO_PARTS, HELLO_KIDS, 1, "Alice");
  assert.equal(res.ok, false);
  assert.equal(res.dynamic, true);
  assert.equal(res.reason, "dynamic");
});

test("resolveTextSegmentEdit: refuses when DOM node count != render-producing part count", () => {
  // A `{list.map(...)}` rendered two nodes where source has one dynamic hole.
  const extraKids = [...HELLO_KIDS, { t: 0, v: "overflow" }];
  const res = resolveTextSegmentEdit(HELLO_PARTS, extraKids, 0, "Hi ");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "count-mismatch");
});

test("resolveTextSegmentEdit: refuses when a static part sits over a non-text node (misaligned)", () => {
  const kids = [
    { t: 1 }, // element where source says static -> skew
    { t: 0, v: "Theo" },
    { t: 0, v: ", " },
    { t: 0, v: "5" },
    { t: 0, v: " items" },
  ];
  const res = resolveTextSegmentEdit(HELLO_PARTS, kids, 2, "x");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "misaligned");
});

test("resolveTextSegmentEdit: aligns static text runs around a nested element child", () => {
  // `<p>Save <strong>{n}</strong> now</p>`
  const parts = [
    { kind: "static", index: 0, text: "Save ", whitespaceOnly: false },
    { kind: "element", index: 1, tag: "strong" },
    { kind: "static", index: 2, text: " now", whitespaceOnly: false },
  ];
  const kids = [
    { t: 0, v: "Save " },
    { t: 1 },
    { t: 0, v: " now" },
  ];
  const res = resolveTextSegmentEdit(parts, kids, 2, " later");
  assert.equal(res.ok, true);
  assert.equal(res.segmentIndex, 2);
  assert.equal(res.newText, " later");
});

test("reconstructRawSegment: preserves newline-bearing source indentation around the edit", () => {
  // Raw JSXText "\n  Hello " renders "Hello " — a new value must keep the "\n  ".
  const rc = reconstructRawSegment("\n  Hello ", "Hi ");
  assert.equal(rc.ok, true);
  assert.equal(rc.newText, "\n  Hi ");
});

test("reconstructRawSegment: single-line run reconstructs to the new value verbatim", () => {
  const rc = reconstructRawSegment("Hello ", "Hi there ");
  assert.equal(rc.ok, true);
  assert.equal(rc.newText, "Hi there ");
});

test("reconstructRawSegment: refuses a multi-line static core (not safely reversible)", () => {
  const rc = reconstructRawSegment("Hello\n  world", "x");
  assert.equal(rc.ok, false);
  assert.equal(rc.reason, "multiline-static");
});

test("resolveTextSegmentEdit: reconstructs indentation through the full resolve", () => {
  const parts = [
    { kind: "static", index: 0, text: "\n      Hello ", whitespaceOnly: false },
    { kind: "dynamic", index: 1, expr: "name" },
    { kind: "static", index: 2, text: "\n    ", whitespaceOnly: true }, // trailing indent -> no node
  ];
  const kids = [
    { t: 0, v: "Hello " },
    { t: 0, v: "Theo" },
  ];
  const res = resolveTextSegmentEdit(parts, kids, 0, "Hi ");
  assert.equal(res.ok, true);
  assert.equal(res.segmentIndex, 0);
  assert.equal(res.oldText, "\n      Hello ");
  assert.equal(res.newText, "\n      Hi ");
});

test("buildSetTextSegmentChange: builds a valid change", () => {
  const res = buildSetTextSegmentChange(SEG_CONTEXT, 2, ", ", " and ");
  assert.equal(res.ok, true);
  assert.equal(res.change.op, "set-text-segment");
  assert.equal(res.change.segmentIndex, 2);
  assert.equal(res.change.oldText, ", ");
  assert.equal(res.change.newText, " and ");
  assert.equal(res.change.element, SEG_CONTEXT);
});

test("buildSetTextSegmentChange: skips when the element has no source location", () => {
  const res = buildSetTextSegmentChange({ tagName: "p", classList: [] }, 0, "a", "b");
  assert.equal(res.ok, false);
  assert.match(res.reason, /set-text-segment/);
});
