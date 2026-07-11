// background/summary.test.js — unit tests for the pure autosave-toast helpers.
// Run with: node --test background/summary.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, summarizeAutosave } from "./summary.js";

test("baseName strips directories (posix + win) and handles edge inputs", () => {
  assert.equal(baseName("src/components/PlainCard.css"), "PlainCard.css");
  assert.equal(baseName("src\\components\\App.tsx"), "App.tsx");
  assert.equal(baseName("App.tsx"), "App.tsx");
  assert.equal(baseName(""), "");
  assert.equal(baseName(undefined), "");
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
