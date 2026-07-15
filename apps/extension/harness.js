// harness.js — a scriptable, in-page verification surface for the REAL
// capture→apply pipeline, mounted ONLY when the page URL carries ?dsHarness
// (opt-in, so it never appears in normal dev). It exists because the DevTools
// panel's poller (devtools.js) only runs while native DevTools is open on the
// tab, and an automated driver (Playwright / claude-in-chrome) can drive
// injected page DOM but CANNOT drive the native DevTools chrome. This harness
// puts a Shadow-DOM dialog on the page that exercises the SAME capture-core
// primitives devtools.js uses, so "does capture work for framework X" becomes
// a scriptable page interaction instead of a manual DevTools session.
//
// Faithfulness: it imports capture-core.js (the module devtools.js imports),
// mutates the live CSSOM/DOM exactly as a Styles/Elements-panel edit would
// (CSSStyleRule.style.setProperty, node.setAttribute, …), then runs the
// identical serialize → diff → build → buildPayload → postApply chain. The
// only harness-local code is the two snapshot-diff loops (sheets, elements) —
// they mirror devtools.js's pollCss()/pollElements() but compare a
// before/after pair instead of a persistent poller snapshot; every CaptureChange
// still comes out of the shared builders, so the produced payload is real.
//
// This is a dev/test tool. It runs in the content-script isolated world (shares
// the page's live CSSOM/DOM), is gated off by default, and matches localhost
// only via the manifest content_scripts match — it never ships to a user page.

"use strict";

const HARNESS_HOST_ID = "dev-sync-harness-host";
const MOUNT_PREFIX = "/__dev-sync"; // must match the server mount + devtools.js

// Opt-in gate: only mount when ?dsHarness (any value, or bare) is present.
function harnessRequested() {
  return /[?&]dsHarness(=|&|$)/.test(location.search);
}

// ---------------------------------------------------------------------------
// capture-core is a web_accessible ES module; the isolated-world content script
// reaches it by extension URL. Load once, lazily, on first mount.
let corePromise = null;
function loadCore() {
  if (!corePromise) {
    corePromise = import(chrome.runtime.getURL("capture-core.js"));
  }
  return corePromise;
}

// ---------------------------------------------------------------------------
// World boundary. This harness runs in the content-script ISOLATED world, which
// shares the page's DOM + CSSOM but NOT its JS heap. serializeSheets() reads
// only the shared CSSOM, so it runs here directly. serializeElements() reads
// each element's off-DOM `__srcLoc` property, which the framework's runtime sets
// in the MAIN world and the isolated world can't see — so it must run there,
// exactly as devtools.js runs it via inspectedWindow.eval. capture-core exports
// SERIALIZE_ELEMENTS (an IIFE string that JSON.stringifies the result) for this:
// hand it to harness-main.js (a "world":"MAIN" content script) over window
// .postMessage, which evals it in the page world and posts the JSON back.
//
// DOM/CSSOM MUTATIONS are shared, so the harness mutates from the isolated world
// and the main-world serialize sees the change. (An earlier attempt injected an
// inline <script> to run the serialize; content-script-injected inline scripts
// execute unreliably across the world boundary, so the dedicated MAIN-world
// content script — CSP-exempt, always present — is the robust path.)
let evalSeq = 0;
function evalInMain(exprReturningJsonString) {
  return new Promise((resolve, reject) => {
    const id = "dsh-" + ++evalSeq + "-" + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("main-world eval timed out — is harness-main.js loaded?"));
    }, 3000);
    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__dsHarness !== "eval-result" || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.ok) resolve(data.result);
      else reject(new Error("main-world eval failed: " + data.error));
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ __dsHarness: "eval", id, expr: exprReturningJsonString }, location.origin);
  });
}

async function serializeElementsMainWorld(core) {
  return JSON.parse(await evalInMain(core.SERIALIZE_ELEMENTS));
}

// ---------------------------------------------------------------------------
// CSS-modify path — mirrors devtools.js pollCss().
//
// Find the live CSSStyleRule by selectorText and set a property on it (exactly
// what a Styles-panel edit does under the hood), then diff serializeSheets()
// before/after and run diffSheet() on whichever mappable sheet changed.

function findCssRule(selector) {
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — not ours
    }
    if (!rules) continue;
    for (const rule of rules) {
      if (rule && rule.selectorText === selector) return rule;
    }
  }
  return null;
}

// A linked (<link>) dev sheet strips its /*# sourceMappingURL */ from the CSSOM,
// so recover it by fetching the sheet bytes — same fallback devtools.js uses.
async function recoverSheetMap(core, sourceURL) {
  if (!sourceURL || !/^https?:\/\//.test(sourceURL)) return "";
  try {
    const res = await fetch(sourceURL);
    if (!res.ok) return "";
    return core.extractSourceMappingURL(await res.text());
  } catch {
    return "";
  }
}

async function captureModify(core, selector, property, value) {
  const before = core.serializeSheets();
  const rule = findCssRule(selector);
  if (!rule) throw new Error(`no CSS rule matches selectorText "${selector}"`);
  rule.style.setProperty(property, value);
  const after = core.serializeSheets();

  const changes = [];
  for (const now of after) {
    if (!now.mappable) continue;
    const prev = before.find((s) => s.key === now.key);
    if (!prev || prev.rulesText === now.rulesText) continue;
    const mapURL = now.sourceMapURL || (await recoverSheetMap(core, now.sourceURL));
    const ref = {
      id: "eval:" + now.key,
      sourceURL: now.sourceURL,
      origin: "regular",
      ...(mapURL ? { sourceMapURL: mapURL } : {}),
    };
    for (const c of core.diffSheet(ref, prev.rulesText, now.rulesText)) {
      changes.push(c);
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// DOM-op path — mirrors devtools.js pollElements().
//
// Mutate the live node, then diff serializeElements() before/after. The
// serialized element → ElementContext mapping and the per-op builder dispatch
// are byte-for-byte what pollElements() does; only the persistent snapshot maps
// are replaced by a stateless before/after comparison.

function contextFor(el) {
  return {
    tagName: el.tag,
    classList: Array.isArray(el.classList) ? el.classList : [],
    dataSourceFile: el.file,
    dataSourceLine: el.line,
    ...(el.component ? { dataSourceComponent: el.component } : {}),
  };
}

function diffElementSnapshots(core, before, after) {
  const prevByKey = new Map(before.map((el) => [`${el.file}:${el.line}`, el]));
  const changes = [];
  for (const el of after) {
    const prev = prevByKey.get(`${el.file}:${el.line}`);
    if (!prev) continue;
    const context = contextFor(el);

    // inline style → promote-inline
    if (prev.cssText !== el.cssText && el.cssText) {
      const r = core.buildPromoteInlineStyleChange(context, el.cssText);
      if (r.ok) changes.push(r.change);
    }

    // whole-body text → set-text (leaf, single text child only — mixed content
    // is the segment tier, which needs a server /describe round-trip and is out
    // of scope for the harness's one-shot capture)
    const kids = Array.isArray(el.kids) ? el.kids : [];
    if (el.leaf && kids.length <= 1) {
      const prevText = typeof prev.text === "string" ? prev.text : "";
      const text = typeof el.text === "string" ? el.text : "";
      if (prevText !== text) {
        const r = core.buildSetTextChange(context, text, prevText);
        if (r.ok) changes.push(r.change);
      }
    }

    // attributes → set-attr
    const curAttrs = el.attrs && typeof el.attrs === "object" ? el.attrs : {};
    const prevAttrs = prev.attrs && typeof prev.attrs === "object" ? prev.attrs : {};
    for (const name of Object.keys(curAttrs)) {
      if (prevAttrs[name] !== curAttrs[name]) {
        const r = core.buildSetAttrChange(context, name, curAttrs[name]);
        if (r.ok) changes.push(r.change);
      }
    }
  }
  return changes;
}

async function captureDom(core, op, selector, attr, value) {
  const before = await serializeElementsMainWorld(core);
  const node = document.querySelector(selector);
  if (!node) throw new Error(`no element matches "${selector}"`);
  if (op === "set-text") {
    node.textContent = value;
  } else if (op === "set-attr") {
    if (!attr) throw new Error("set-attr needs an attribute name in the prop field");
    node.setAttribute(attr, value);
  } else if (op === "promote-inline") {
    node.style.cssText = value;
  } else {
    throw new Error(`unknown DOM op "${op}"`);
  }
  const after = await serializeElementsMainWorld(core);
  return diffElementSnapshots(core, before, after);
}

// ---------------------------------------------------------------------------
// Run one capture → apply cycle and hand back a verdict object.

async function runOnce({ op, selector, prop, value }) {
  const core = await loadCore();
  let changes;
  if (op === "modify") {
    changes = await captureModify(core, selector, prop, value);
  } else {
    changes = await captureDom(core, op, selector, prop, value);
  }
  if (!changes.length) {
    return {
      status: "empty",
      note: "no CaptureChange produced — did the mutation land? check selector/property.",
    };
  }
  const base = location.origin + MOUNT_PREFIX;
  const payload = core.buildPayload(changes, location.href, { applyMode: "commit" });
  const apply = await core.postApply(base, payload);
  if (!apply.ok) {
    return { status: "http-error", httpStatus: apply.status, body: apply.body, payload };
  }
  return { status: "ok", result: apply.result, payload };
}

// ---------------------------------------------------------------------------
// Shadow-DOM dialog. Fixed ids so a driver can address every control:
//   #ds-h-selector #ds-h-op #ds-h-prop #ds-h-value #ds-h-run #ds-h-result
// #ds-h-result carries machine-readable data-* attrs (status / applied count /
// first mode / first skip reason) so an e2e assert never has to parse text.

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  for (const k of kids) node.append(k);
  return node;
}

function buildDialog(onRun) {
  const host = document.createElement("div");
  host.id = HARNESS_HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .panel {
      position: fixed; top: 12px; right: 12px; z-index: 2147483647;
      width: 320px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #e5e7eb; background: #111827; border: 1px solid #374151;
      border-radius: 8px; padding: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.4);
    }
    .title { font-weight: 600; margin: 0 0 8px; color: #93c5fd; }
    label { display: block; margin: 6px 0 2px; color: #9ca3af; }
    input, select {
      width: 100%; box-sizing: border-box; padding: 4px 6px;
      background: #1f2937; color: #e5e7eb; border: 1px solid #374151;
      border-radius: 4px; font: inherit;
    }
    button {
      margin-top: 8px; width: 100%; padding: 6px; cursor: pointer;
      background: #2563eb; color: #fff; border: 0; border-radius: 4px; font: inherit;
    }
    button:hover { background: #1d4ed8; }
    pre {
      margin: 8px 0 0; padding: 6px; max-height: 220px; overflow: auto;
      background: #0b1020; border: 1px solid #374151; border-radius: 4px;
      white-space: pre-wrap; word-break: break-word;
    }
  `;

  const selector = el("input", { id: "ds-h-selector", placeholder: ".card / h3.title" });
  const opSel = el(
    "select",
    { id: "ds-h-op" },
    el("option", { value: "modify", textContent: "modify (CSS property)" }),
    el("option", { value: "set-text", textContent: "set-text" }),
    el("option", { value: "set-attr", textContent: "set-attr" }),
    el("option", { value: "promote-inline", textContent: "promote-inline" }),
  );
  const prop = el("input", { id: "ds-h-prop", placeholder: "padding / data-x / (unused)" });
  const value = el("input", { id: "ds-h-value", placeholder: "40px / new text / color:red" });
  const run = el("button", { id: "ds-h-run", textContent: "Run capture → apply" });
  const result = el("pre", { id: "ds-h-result", textContent: "idle" });
  result.dataset.status = "idle";

  run.addEventListener("click", async () => {
    result.dataset.status = "running";
    result.textContent = "running…";
    run.disabled = true;
    try {
      const verdict = await onRun({
        op: opSel.value,
        selector: selector.value.trim(),
        prop: prop.value.trim(),
        value: value.value,
      });
      renderVerdict(result, verdict);
    } catch (e) {
      result.dataset.status = "error";
      result.textContent = "error: " + String((e && e.message) || e);
    } finally {
      run.disabled = false;
    }
  });

  const panel = el(
    "div",
    { className: "panel" },
    el("p", { className: "title", textContent: "dev-sync capture harness" }),
    el("label", { textContent: "selector" }),
    selector,
    el("label", { textContent: "op" }),
    opSel,
    el("label", { textContent: "prop (CSS property / attr name)" }),
    prop,
    el("label", { textContent: "value" }),
    value,
    run,
    result,
  );

  root.append(style, panel);
  return host;
}

function renderVerdict(result, verdict) {
  // Machine-readable summary for e2e asserts.
  result.dataset.status = verdict.status;
  delete result.dataset.appliedCount;
  delete result.dataset.skippedCount;
  delete result.dataset.mode;
  delete result.dataset.skipReason;
  if (verdict.status === "ok") {
    const r = verdict.result || {};
    const applied = Array.isArray(r.applied) ? r.applied : [];
    const skipped = Array.isArray(r.skipped) ? r.skipped : [];
    result.dataset.appliedCount = String(applied.length);
    result.dataset.skippedCount = String(skipped.length);
    if (applied[0] && applied[0].mode) result.dataset.mode = applied[0].mode;
    if (skipped[0] && skipped[0].reason) result.dataset.skipReason = skipped[0].reason;
  }
  result.textContent = JSON.stringify(verdict, null, 2);
}

function mount() {
  if (document.getElementById(HARNESS_HOST_ID)) return;
  const host = buildDialog(runOnce);
  (document.body || document.documentElement).append(host);
}

if (harnessRequested()) {
  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
}
