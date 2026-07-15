// capture-core.test.js — unit tests for the shared capture-core module.
// No browser, no chrome.* — this proves the extracted primitives work in
// isolation (the same guarantee background/diff.test.js gives diff.js).
//
// Run with: node --test capture-core.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSheet,
  buildPromoteInlineStyleChange,
  buildSetTextChange,
  buildSetTextSegmentChange,
  buildSetAttrChange,
  buildRemoveAttrChange,
  resolveTextSegmentEdit,
  extractSourceMappingURL,
  serializeSheets,
  SERIALIZE_SHEETS,
  serializeElements,
  SERIALIZE_ELEMENTS,
  buildPayload,
  postApply,
} from "./capture-core.js";

const SHEET_REF = { id: "sheet-1", sourceURL: "http://localhost/app.css", origin: "regular" };

// ---------------------------------------------------------------------------
// diffSheet — proves the re-exported differ works in isolation through this
// module's surface (not just through background/diff.js directly).
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

test("diffSheet: add-rule — brand-new rule with no prior anchor", () => {
  const oldText = ".card { color: red; }";
  const newText = ".card { color: red; }\n.badge { color: blue; }\n";
  const changes = diffSheet(SHEET_REF, oldText, newText);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "add-rule");
  assert.equal(changes[0].selector, ".badge");
});

// ---------------------------------------------------------------------------
// Re-exported diff.js builders / sourcemap-url.js — smoke-test that the
// facade forwards to the real implementation, not a stale copy.
// ---------------------------------------------------------------------------

test("buildSetAttrChange / buildRemoveAttrChange forward through the facade", () => {
  const context = { tagName: "div", classList: [], dataSourceFile: "App.tsx", dataSourceLine: 10 };
  const set = buildSetAttrChange(context, "title", "hi");
  assert.equal(set.ok, true);
  assert.equal(set.change.op, "set-attr");

  const remove = buildRemoveAttrChange(context, "title");
  assert.equal(remove.ok, true);
  assert.equal(remove.change.op, "remove-attr");
});

test("extractSourceMappingURL forwards through the facade", () => {
  const css = "body{color:red}\n/*# sourceMappingURL=app.css.map */";
  assert.equal(extractSourceMappingURL(css), "app.css.map");
});

// ---------------------------------------------------------------------------
// serializeSheets()/serializeElements() <-> SERIALIZE_SHEETS/SERIALIZE_ELEMENTS
// — the eval-string must be MECHANICALLY derived from the function (same
// body), not hand-copied, so they can't drift.
// ---------------------------------------------------------------------------

test("SERIALIZE_SHEETS is derived from serializeSheets(), not hand-duplicated", () => {
  const body = serializeSheets.toString();
  assert.ok(SERIALIZE_SHEETS.includes(body), "eval-string must embed the function's own source");
  assert.match(SERIALIZE_SHEETS, /^\(\(\) => JSON\.stringify\(\(/);
});

test("SERIALIZE_ELEMENTS is derived from serializeElements(), not hand-duplicated", () => {
  const body = serializeElements.toString();
  assert.ok(SERIALIZE_ELEMENTS.includes(body), "eval-string must embed the function's own source");
  assert.match(SERIALIZE_ELEMENTS, /^\(\(\) => JSON\.stringify\(\(/);
});

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------

test("buildPayload defaults applyMode to commit (headless autosave has no preview UI)", () => {
  const changes = [{ op: "modify" }];
  const payload = buildPayload(changes, "http://localhost:3000/");
  assert.deepEqual(payload, {
    url: "http://localhost:3000/",
    changes,
    applyMode: "commit",
  });
});

test("buildPayload honors an explicit applyMode override", () => {
  const payload = buildPayload([], "http://localhost:3000/", { applyMode: "preview" });
  assert.equal(payload.applyMode, "preview");
});

// ---------------------------------------------------------------------------
// postApply — stub global fetch, no network/chrome dependency.
// ---------------------------------------------------------------------------

test("postApply: 200 returns {ok: true, result}", async (t) => {
  const applyResult = { applied: [], skipped: [], needsPlacement: [] };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "http://localhost:3000/__dev-sync/apply");
    assert.equal(init.method, "POST");
    return {
      ok: true,
      status: 200,
      json: async () => applyResult,
    };
  });

  const out = await postApply("http://localhost:3000/__dev-sync", { url: "x", changes: [], applyMode: "commit" });
  assert.deepEqual(out, { ok: true, status: 200, result: applyResult });
});

test("postApply: non-2xx returns {ok: false, status, body}", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 404,
    text: async () => "not mounted",
  }));

  const out = await postApply("http://localhost:3000/__dev-sync", { url: "x", changes: [], applyMode: "commit" });
  assert.deepEqual(out, { ok: false, status: 404, body: "not mounted" });
});

test("postApply: network failure propagates (caller's to handle)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });

  await assert.rejects(
    () => postApply("http://localhost:3000/__dev-sync", { url: "x", changes: [], applyMode: "commit" }),
    /network down/,
  );
});
