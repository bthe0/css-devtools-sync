// capture-core.js — pure capture primitives shared between the DevTools
// headless client (devtools.js) and an in-page capture harness.
//
// Nothing here touches chrome.* (postApply's fetch is the sole exception —
// fetch runs identically in a devtools page and in an in-page harness). The
// serialize/diff/build functions all take-plain-data-return-plain-data, so a
// second consumer that runs IN the inspected page (and can therefore call
// serializeSheets()/serializeElements() directly, no inspectedWindow.eval
// round-trip needed) gets the IDENTICAL logic devtools.js uses — not a
// reimplementation.
//
// POLICY stays out of this file: no snapshot maps, no revert guards, no
// autosave timers, no styled-components/Tailwind gating, no CDP session
// bridging. Those live in devtools.js (and call into this module).

"use strict";

import {
  diffSheet,
  buildPromoteInlineStyleChange,
  buildSetTextChange,
  buildSetTextSegmentChange,
  buildSetAttrChange,
  buildRemoveAttrChange,
  resolveTextSegmentEdit,
} from "./background/diff.js";
import { extractSourceMappingURL } from "./background/sourcemap-url.js";

// Re-exported so a consumer can import the whole capture surface from this
// one module instead of also reaching into background/diff.js and
// background/sourcemap-url.js directly — those files remain the single
// source of truth for this logic (diffSheet et al. are also imported
// unmodified by background/service-worker.js), nothing is duplicated here.
export {
  diffSheet,
  buildPromoteInlineStyleChange,
  buildSetTextChange,
  buildSetTextSegmentChange,
  buildSetAttrChange,
  buildRemoveAttrChange,
  resolveTextSegmentEdit,
  extractSourceMappingURL,
};

// ---------------------------------------------------------------------------
// Stylesheet serialization
//
// Serialize every readable stylesheet: current rule text (post-edit CSSOM
// state) plus the sourceMappingURL comment the bundler injected — the server
// needs the map to trace an inline <style> back to its source file.
// Cross-origin sheets throw on .cssRules and are skipped.
// ---------------------------------------------------------------------------

/**
 * Runs IN the inspected page. Reads the live CSSOM (document.styleSheets)
 * and returns one entry per readable sheet. This function's source is also
 * the body of SERIALIZE_SHEETS below (derived via toString(), see there) —
 * so the eval-string devtools.js feeds to inspectedWindow.eval and the
 * callable an in-page harness calls directly can never drift apart.
 * @returns {Array<{key: string, sourceURL: string, sourceMapURL: string, mappable: boolean, styled: boolean, rulesText: string}>}
 */
export function serializeSheets() {
  const out = [];
  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    let rulesText = "";
    try {
      const rules = sheet.cssRules;
      for (let j = 0; j < rules.length; j++) rulesText += rules[j].cssText + "\n";
    } catch (e) {
      continue; // cross-origin stylesheet — not readable, not ours to sync
    }
    const owner = sheet.ownerNode;
    const ownerText = owner && owner.tagName === "STYLE" ? owner.textContent || "" : "";
    const mapMatch = (ownerText || rulesText).match(/\/\*#\s*sourceMappingURL=([^*]+?)\s*\*\//);
    // Stable identity across HMR/reorder: Vite tags each dev <style> with its
    // source path; prefer that, then the sheet href, then the array index (last
    // resort — index can shift if sheets are inserted/removed).
    const viteId = owner && owner.getAttribute ? owner.getAttribute("data-vite-dev-id") : null;
    const sourceMapURL = mapMatch ? mapMatch[1].trim() : "";
    // styled-components v6 injects an unmapped <style data-styled> whose rules
    // are opaque hashes (.hdbeaO). It carries NO sourcemap, so it's only
    // syncable via the selected element's displayName class (see the styled
    // gating in pollCss) — mark it so the poller lets its edits through but
    // treats them specially.
    const styled = owner && owner.getAttribute ? owner.getAttribute("data-styled") !== null : false;
    // A sheet is syncable ONLY if the server can trace it back to a source file:
    // a Vite dev id (real .css/.scss/.module), an href (external stylesheet), an
    // embedded sourceMappingURL (Emotion <style data-emotion>), or a
    // styled-components marker (resolved by element, above). Other runtime
    // CSS-in-JS / injected <style> tags map to no file — the server always skips
    // them, and the libraries re-inject/reorder rules on re-render, so diffing
    // them would POST a stream of doomed changes → an endless "N skipped" toast
    // with no user action. Skip those.
    const mappable = Boolean(viteId || sheet.href || sourceMapURL || styled);
    // STABLE key across HMR: Next serves CSS as <link href="…/layout.css?v=123">
    // and bumps ?v= on every rebuild. Keying the snapshot by the versioned href
    // makes each rebuild a brand-new key that re-BASELINES with no emit — so an
    // edit made in the HMR window (e.g. delete a value then retype it) lands in
    // that fresh baseline and is never diffed/applied ("doesn't update in DOM").
    // Strip the query so the key survives ?v= bumps; keep the versioned sourceURL
    // for map fetching (the map content is per-build). Vite is unaffected (viteId).
    const hrefKey = sheet.href ? sheet.href.split("?")[0] : "";
    out.push({
      key: viteId || hrefKey || "inline:" + i,
      // Prefer href (external <link>); else fall back to the Vite dev id so the
      // server can resolve the source. An inline <style> has NO href, and some
      // frameworks emit NO inline sourceMappingURL either — Astro's scoped
      // <style> and vanilla-extract's virtual .vanilla.css both do. Without this,
      // the viteId (the real module path, e.g. /…/Card.astro?astro&type=style&…)
      // survived only in `key`, which resolve.ts never reads, so the change died
      // with "source file not found". The server strips the ?query and
      // progressive-strips the abs prefix (resolveExistingFile), so the raw
      // viteId resolves cleanly. Sheets WITH an inline map (Vue/Svelte/React-Vite)
      // are unaffected — the sourcemap pass still wins first.
      sourceURL: sheet.href || viteId || "",
      sourceMapURL: sourceMapURL,
      mappable: mappable,
      styled: styled,
      rulesText: rulesText,
    });
  }
  return out;
}

// The eval-string devtools.js hands to chrome.devtools.inspectedWindow.eval.
// Derived from serializeSheets() itself (not maintained by hand) so the two
// can't drift: same body, wrapped as an IIFE that JSON.stringifies the result
// (inspectedWindow.eval needs a JSON-serializable return value; the harness
// calls serializeSheets() directly and gets the array back unwrapped).
export const SERIALIZE_SHEETS = `(() => JSON.stringify((${serializeSheets.toString()})()))()`;

// ---------------------------------------------------------------------------
// Element serialization
//
// Serialize EVERY instrumented element (has __srcLoc). Include empty inline
// styles on purpose: an element styled only by a class has cssText="" at
// load, and the whole point is to catch the user ADDING an inline style in
// DevTools — excluding empties would let it first appear already carrying
// the edit and get baselined away. `leaf` marks elements whose sole content
// is text (no child ELEMENTS): only those are `set-text` candidates (the
// server refuses to edit text on elements with mixed/nested children), so
// `text` is captured for them.
// ---------------------------------------------------------------------------

/**
 * Runs IN the inspected page. Walks every element carrying an off-DOM
 * `__srcLoc` (attached by the source-locator runtime ref) and serializes
 * what the poller needs to diff. Same derive-the-string relationship to
 * SERIALIZE_ELEMENTS as serializeSheets() has to SERIALIZE_SHEETS above.
 * @returns {Array<{file: string, line: number, component: string, tag: string, classList: string[], cssText: string, attrs: Record<string,string>, leaf: boolean, text: string|null, kids: Array<{t: number, v?: string}>}>}
 */
export function serializeElements() {
  const out = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const loc = el.__srcLoc;
    if (!loc || typeof loc !== "object" || !loc.dataSourceFile) continue;
    if (!Number.isInteger(loc.dataSourceLine) || loc.dataSourceLine <= 0) continue;
    const leaf = el.childElementCount === 0;
    // Every attribute except class + style (class is the classlist/Tailwind
    // tier, style is the inline-promote tier — both handled separately). The
    // source-locator attributes are off-DOM now, so nothing else to exclude.
    var attrs = {};
    var at = el.attributes;
    for (var k = 0; k < at.length; k++) {
      var nm = at[k].name;
      if (nm === "class" || nm === "style") continue;
      attrs[nm] = at[k].value;
    }
    // Serialize the element's DIRECT child nodes as {t, v} — t: 0=text (v=value),
    // 1=element, 2=other (comment/etc). This is the input to the text-SEGMENT
    // tier: a MIXED element (static runs interleaved with {expr}/nested tags)
    // has >1 kid, and diffing per-text-node lets us pinpoint which single static
    // run the user edited and map it to its source JSXText via /describe.
    var kids = [];
    var cn = el.childNodes;
    for (var m = 0; m < cn.length; m++) {
      var node = cn[m];
      if (node.nodeType === 3) kids.push({ t: 0, v: node.nodeValue });
      else if (node.nodeType === 1) kids.push({ t: 1 });
      else kids.push({ t: 2 });
    }
    out.push({
      file: loc.dataSourceFile,
      line: loc.dataSourceLine,
      component: typeof loc.dataSourceComponent === "string" ? loc.dataSourceComponent : "",
      tag: el.tagName.toLowerCase(),
      classList: Array.prototype.slice.call(el.classList),
      cssText: el.style && el.style.cssText ? el.style.cssText : "",
      attrs: attrs,
      leaf: leaf,
      text: leaf ? el.textContent : null,
      kids: kids,
    });
  }
  return out;
}

// See SERIALIZE_SHEETS above — same derivation, same reason.
export const SERIALIZE_ELEMENTS = `(() => JSON.stringify((${serializeElements.toString()})()))()`;

// ---------------------------------------------------------------------------
// Payload + apply POST
// ---------------------------------------------------------------------------

/**
 * Build the CapturePayload POSTed to /apply.
 *
 * `opts.applyMode` defaults to "commit" — headless autosave (and a harness
 * driving the same flow) has no preview UI, so it must always request an
 * immediate commit. The contract's applyMode defaults to "preview"; without
 * this default, autosave would silently stop writing anything the moment the
 * server starts honoring that default.
 * @param {import("@dev-sync/contract").CaptureChange[]} changes
 * @param {string} url
 * @param {{applyMode?: "commit"|"preview"}} [opts]
 * @returns {import("@dev-sync/contract").CapturePayload}
 */
export function buildPayload(changes, url, opts = {}) {
  const { applyMode = "commit" } = opts;
  /** @type {import("@dev-sync/contract").CapturePayload} */
  const payload = {
    url,
    changes,
    applyMode,
  };
  return payload;
}

/**
 * POST a capture payload to the embedded apply engine's /apply endpoint.
 * Pure networking, no chrome.* — runs identically from the DevTools headless
 * client and an in-page harness.
 *
 * Does not interpret the result (toasting/HUD status is caller policy) and
 * does not swallow a network failure (`fetch` rejecting propagates to the
 * caller) or a malformed-JSON-on-200 failure (`res.json()` rejecting
 * propagates too) — both are the caller's to handle, matching the original
 * inline call site this was extracted from.
 * @param {string} base origin + mount prefix, e.g. "http://localhost:3000/__dev-sync"
 * @param {import("@dev-sync/contract").CapturePayload} payload
 * @returns {Promise<{ok: true, status: number, result: import("@dev-sync/contract").ApplyResult} | {ok: false, status: number, body: string}>}
 */
export async function postApply(base, payload) {
  const res = await fetch(`${base}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, body };
  }
  const result = await res.json();
  return { ok: true, status: res.status, result };
}
