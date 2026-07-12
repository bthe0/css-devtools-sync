// background/sourcemap-url.test.js — unit tests for the pure map-URL extractor.
// Run with: node --test background/sourcemap-url.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSourceMappingURL } from "./sourcemap-url.js";

test("pulls an inline base64 data-URI map (the webpack filename:false shape)", () => {
  const css =
    ".tier{margin-bottom:32px}\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2IjozfQ== */";
  assert.equal(
    extractSourceMappingURL(css),
    "data:application/json;charset=utf-8;base64,eyJ2IjozfQ==",
  );
});

test("pulls an external .map reference", () => {
  assert.equal(
    extractSourceMappingURL(".a{}\n/*# sourceMappingURL=layout.css.map */"),
    "layout.css.map",
  );
});

test("returns '' when there is no map comment (CSSOM-stripped rulesText)", () => {
  assert.equal(extractSourceMappingURL(".tier{margin-bottom:32px}"), "");
});

test("returns '' for empty / non-string input", () => {
  assert.equal(extractSourceMappingURL(""), "");
  assert.equal(extractSourceMappingURL(undefined), "");
  assert.equal(extractSourceMappingURL(null), "");
});

test("takes the LAST comment when several appear (real map wins over content)", () => {
  const css =
    '.x{content:"/*# sourceMappingURL=decoy.map */"}\n/*# sourceMappingURL=real.css.map */';
  assert.equal(extractSourceMappingURL(css), "real.css.map");
});

test("tolerates whitespace variants around the token", () => {
  assert.equal(extractSourceMappingURL("/*#sourceMappingURL=a.map*/"), "a.map");
  assert.equal(extractSourceMappingURL("/*#   sourceMappingURL=b.map   */"), "b.map");
});
