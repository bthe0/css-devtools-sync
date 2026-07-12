// background/summary.test.js — unit tests for the pure autosave-toast helpers.
// Run with: node --test background/summary.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, summarizeAutosave, isDynamicMarkupSkip, partitionSkips } from "./summary.js";

test("baseName strips directories (posix + win) and handles edge inputs", () => {
  assert.equal(baseName("src/components/PlainCard.css"), "PlainCard.css");
  assert.equal(baseName("src\\components\\App.tsx"), "App.tsx");
  assert.equal(baseName("App.tsx"), "App.tsx");
  assert.equal(baseName(""), "");
  assert.equal(baseName(undefined), "");
  assert.equal(baseName("a/b/"), "b"); // trailing sep must not swallow the basename
  assert.equal(baseName("a\\b\\"), "b");
});

test("single applied change, no skips -> success", () => {
  const { text, kind } = summarizeAutosave([{ file: "src/components/PlainCard.css" }], 0);
  assert.equal(text, "Autosaved 1 change → PlainCard.css");
  assert.equal(kind, "success");
});

test("plural applied, dedupes files, first-seen order", () => {
  const { text } = summarizeAutosave(
    [
      { file: "src/a/PlainCard.css" },
      { file: "src/b/PlainCard.css" }, // same basename -> collapsed
      { file: "src/ImageBlock.tsx" },
    ],
    0,
  );
  assert.equal(text, "Autosaved 3 changes → PlainCard.css, ImageBlock.tsx");
});

test("caps the file list with +N more", () => {
  const applied = ["a.css", "b.css", "c.css", "d.css", "e.css"].map((f) => ({ file: f }));
  const { text } = summarizeAutosave(applied, 0, 3);
  assert.equal(text, "Autosaved 5 changes → a.css, b.css, c.css, +2 more");
});

test("empty-file outcomes don't inflate the count or dangle the arrow", () => {
  // Two outcomes have no basename -> only one real file, count must match.
  const { text } = summarizeAutosave([{ file: "x.css" }, { file: "" }, { file: undefined }], 0);
  assert.equal(text, "Autosaved 1 change → x.css");
});

test("all outcomes fileless -> generic label, no dangling arrow", () => {
  const { text, kind } = summarizeAutosave([{ file: "" }, { file: "" }], 0);
  assert.equal(text, "Nothing to autosave");
  assert.equal(kind, "warn");
});

test("maxFiles=0 clamps to 1 -> no leading comma", () => {
  const applied = ["a.css", "b.css", "c.css"].map((f) => ({ file: f }));
  const { text } = summarizeAutosave(applied, 0, 0);
  assert.equal(text, "Autosaved 3 changes → a.css, +2 more");
});

test("skips append a note and downgrade kind to warn", () => {
  const { text, kind } = summarizeAutosave([{ file: "x.css" }], 2);
  assert.equal(text, "Autosaved 1 change → x.css (2 skipped)");
  assert.equal(kind, "warn");
});

test("nothing applied but something skipped -> warn message", () => {
  const { text, kind } = summarizeAutosave([], 1);
  assert.equal(text, "Nothing autosaved — 1 change skipped");
  assert.equal(kind, "warn");
});

test("nothing applied, nothing skipped -> generic warn", () => {
  const { text, kind } = summarizeAutosave([], 0);
  assert.equal(text, "Nothing to autosave");
  assert.equal(kind, "warn");
});

// A skip on a dynamic/mixed instrumented element is expected, not a failure:
// the poller auto-emits it, the engine declines the expression, devtools.js
// suppresses it. It must not latch amber or inflate the "N skipped" count.
const dynSkip = (op, dataSourceFile = "app/page.tsx", extra = {}) => ({
  change: { op, element: { dataSourceFile, dataSourceLine: 42 }, ...extra },
  reason: "dynamic JSX child — cannot rewrite an expression as a literal",
});

test("isDynamicMarkupSkip: set-text/attr on an instrumented element are expected", () => {
  assert.equal(isDynamicMarkupSkip(dynSkip("set-text")), true);
  assert.equal(isDynamicMarkupSkip(dynSkip("set-text-segment")), true);
  assert.equal(isDynamicMarkupSkip(dynSkip("set-attr", "x.tsx", { attribute: "title" })), true);
  assert.equal(isDynamicMarkupSkip(dynSkip("remove-attr", "x.tsx", { attribute: "title" })), true);
});

test("isDynamicMarkupSkip: CSS + placement + uninstrumented skips stay actionable", () => {
  // Plain-CSS resolve failure — op isn't a markup op.
  assert.equal(
    isDynamicMarkupSkip({ change: { op: "modify", styleSheet: { id: "s" } }, reason: "source not found" }),
    false,
  );
  assert.equal(isDynamicMarkupSkip({ change: { op: "add-rule" } }), false);
  // A markup op with no instrumented source (no dataSourceFile) can't be suppressed → surface it.
  assert.equal(isDynamicMarkupSkip({ change: { op: "set-text", element: {} } }), false);
  assert.equal(isDynamicMarkupSkip({ change: { op: "set-text", element: { dataSourceFile: "" } } }), false);
  // Defensive: malformed items never throw, never count as expected.
  assert.equal(isDynamicMarkupSkip(null), false);
  assert.equal(isDynamicMarkupSkip({}), false);
  assert.equal(isDynamicMarkupSkip({ change: null }), false);
  assert.equal(isDynamicMarkupSkip({ change: { op: 7, element: { dataSourceFile: "x" } } }), false);
});

test("partitionSkips separates expected dynamic skips from actionable ones", () => {
  const skipped = [
    dynSkip("set-text"), // expected
    { change: { op: "modify", styleSheet: { id: "s" } }, reason: "source file not found" }, // actionable
    dynSkip("set-attr", "y.tsx", { attribute: "aria-label" }), // expected
    { change: { op: "modify" }, reason: "file changed since sync (hand-edit detected)" }, // actionable
  ];
  const { dynamic, actionable } = partitionSkips(skipped);
  assert.equal(dynamic.length, 2);
  assert.equal(actionable.length, 2);
  assert.equal(actionable[0].reason, "source file not found");
});

test("partitionSkips tolerates non-arrays -> empty split", () => {
  assert.deepEqual(partitionSkips(undefined), { dynamic: [], actionable: [] });
  assert.deepEqual(partitionSkips(null), { dynamic: [], actionable: [] });
});

test("a legit edit alongside one dynamic-element skip reports clean (0 actionable)", () => {
  // Regression: user edits a title (applied) while the poller emits the demo's
  // dynamic `<p>Region {{…}}</p>` (skipped). The toast must NOT say "1 skipped".
  const skipped = [dynSkip("set-text")];
  const { actionable } = partitionSkips(skipped);
  const { text, kind } = summarizeAutosave([{ file: "app/page.tsx" }], actionable.length);
  assert.equal(text, "Autosaved 1 change → page.tsx");
  assert.equal(kind, "success");
});
