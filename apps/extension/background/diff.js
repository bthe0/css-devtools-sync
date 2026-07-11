// background/diff.js — pure, browser-free diff/change-building logic.
//
// Every export here takes plain data (stylesheet text, CDP DOM payloads,
// ElementContext-shaped objects) and returns CaptureChange[] or a single
// CaptureChange-or-skip result. Nothing in this file touches `chrome.*` or
// any browser global, so it can be unit-tested with node:test alone (see
// diff.test.js) and is imported unmodified by background/service-worker.js.
//
// Shapes mirror packages/contract/src/index.ts (CaptureChangeSchema and
// friends). This file intentionally does NOT import that package at runtime
// — the unpacked extension has no bundler/module resolution for workspace
// packages — so the DATA_SOURCE_* constants and op shapes below are kept in
// sync BY HAND with the contract. packages/contract/src/index.ts remains the
// source of truth for the wire protocol; if it changes, update this file.

"use strict";

// ---------------------------------------------------------------------------
// Instrumentation attribute names (mirrors @css-sync/contract)
// ---------------------------------------------------------------------------

export const DATA_SOURCE_FILE = "data-source-file";
export const DATA_SOURCE_LINE = "data-source-line";
export const DATA_SOURCE_COMPONENT = "data-source-component";
/** Transient marker devtools.js writes on $0 to hand the selection to the
 * content script; adding/removing it must never be captured as a real edit. */
export const CSS_SYNC_MARKER = "data-css-sync-inspected";

const IGNORED_ATTRS = new Set([
  DATA_SOURCE_FILE,
  DATA_SOURCE_LINE,
  DATA_SOURCE_COMPONENT,
  CSS_SYNC_MARKER,
]);

/**
 * True for attributes the CDP engine must never turn into a set-attr/remove-attr
 * change: the three instrumentation attributes (framework/DevTools bookkeeping
 * churn) AND our own `data-css-sync-inspected` selection marker, which we
 * add/remove on every Elements-panel selection change.
 */
export function isSourceLocatorAttribute(name) {
  return IGNORED_ATTRS.has(name);
}

// ---------------------------------------------------------------------------
// Lightweight CSS parser (enough to diff DevTools-generated sheet text).
// Handles comments, strings, one-or-more levels of @media/@supports nesting.
// Produces flat rules: {selector, mediaText, decls, startOffset, endOffset}.
// ---------------------------------------------------------------------------

export function parseStylesheet(text) {
  const rules = [];
  walkBlock(text, 0, text.length, undefined, rules);
  return rules;
}

function walkBlock(text, start, end, mediaText, out) {
  let i = start;
  while (i < end) {
    // Skip whitespace and comments.
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? end : close + 2;
      continue;
    }

    // Read a prelude up to '{' (rule) or ';' (statement like @import).
    const preludeStart = i;
    let j = i;
    let stop = -1; // index of '{' or ';'
    while (j < end) {
      const c = text[j];
      if (c === "/" && text[j + 1] === "*") {
        const close = text.indexOf("*/", j + 2);
        j = close === -1 ? end : close + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        j = skipString(text, j, end);
        continue;
      }
      if (c === "{" || c === ";") {
        stop = j;
        break;
      }
      j++;
    }
    if (stop === -1) break; // trailing garbage
    if (text[stop] === ";") {
      i = stop + 1; // @import / @charset / stray semicolon — skip
      continue;
    }

    const prelude = text.slice(preludeStart, stop).trim();
    const bodyStart = stop + 1;
    const bodyEnd = findMatchingBrace(text, stop, end);
    const ruleEnd = bodyEnd === -1 ? end : bodyEnd + 1;

    if (prelude.startsWith("@")) {
      const atMatch = prelude.match(/^@([a-zA-Z-]+)\s*(.*)$/s);
      const name = atMatch ? atMatch[1].toLowerCase() : "";
      const condition = atMatch ? atMatch[2].trim() : "";
      if (name === "media") {
        walkBlock(text, bodyStart, bodyEnd === -1 ? end : bodyEnd, condition, out);
      } else if (name === "supports" || name === "layer" || name === "container") {
        // Recurse but keep the outer media context; condition detail is lost
        // (contract only carries mediaText).
        walkBlock(text, bodyStart, bodyEnd === -1 ? end : bodyEnd, mediaText, out);
      }
      // @keyframes, @font-face, etc. — not diffable as selector rules; skip.
    } else if (prelude.length > 0) {
      out.push({
        selector: prelude.replace(/\s+/g, " "),
        mediaText,
        decls: parseDeclarations(text.slice(bodyStart, bodyEnd === -1 ? end : bodyEnd)),
        startOffset: preludeStart,
        endOffset: ruleEnd,
      });
    }
    i = ruleEnd;
  }
}

function skipString(text, i, end) {
  const quote = text[i];
  i++;
  while (i < end) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === quote) return i + 1;
    else i++;
  }
  return end;
}

function findMatchingBrace(text, openIdx, end) {
  let depth = 0;
  for (let i = openIdx; i < end; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i, end) - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip `/* ... *\/` comments, string-aware so a comment sequence inside a
 * quoted value (e.g. `content: "a/*b"`) is preserved. DevTools disables a
 * declaration by COMMENTING IT OUT in place (`/* max-width: 420px; *\/`);
 * without this the comment's inner `:` and `;` would be tokenized as a bogus
 * declaration AND swallow the following real declaration into its value.
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  const end = text.length;
  while (i < end) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? end : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const strEnd = skipString(text, i, end);
      out += text.slice(i, strEnd);
      i = strEnd;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse "prop: value; prop2: value2" into a Map (last write wins). */
function parseDeclarations(rawBody) {
  const decls = new Map();
  const body = stripComments(rawBody);
  let i = 0;
  const end = body.length;
  while (i < end) {
    // Collect one declaration up to ';' (respecting strings/parens/comments).
    let depth = 0;
    const declStart = i;
    while (i < end) {
      const c = body[i];
      if (c === "/" && body[i + 1] === "*") {
        const close = body.indexOf("*/", i + 2);
        i = close === -1 ? end : close + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        i = skipString(body, i, end);
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0) break;
      i++;
    }
    const chunk = body.slice(declStart, i).trim();
    i++; // past ';'
    if (!chunk) continue;
    const colon = chunk.indexOf(":");
    if (colon <= 0) continue;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (prop) decls.set(prop, value);
  }
  return decls;
}

function offsetToLineCol(text, offset) {
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lastNl = i;
    }
  }
  return { line, column: offset - lastNl - 1 };
}

function toSourceRange(text, startOffset, endOffset) {
  const s = offsetToLineCol(text, startOffset);
  const e = offsetToLineCol(text, endOffset);
  return {
    startLine: s.line,
    startColumn: s.column,
    endLine: e.line,
    endColumn: e.column,
  };
}

// ---------------------------------------------------------------------------
// CSS diff engine: old sheet text vs new sheet text -> CaptureChange[]
// ---------------------------------------------------------------------------

/** Key rules by mediaText + selector + occurrence index (duplicate-safe). */
function keyRules(rules) {
  const seen = new Map();
  const keyed = new Map();
  for (const rule of rules) {
    const base = `${rule.mediaText ?? ""} ${rule.selector}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keyed.set(`${base} ${n}`, rule);
  }
  return keyed;
}

export function diffSheet(sheetRef, oldText, newText) {
  const changes = [];
  const oldRules = keyRules(parseStylesheet(oldText));
  const newRules = keyRules(parseStylesheet(newText));

  for (const [key, newRule] of newRules) {
    const oldRule = oldRules.get(key);
    const range = toSourceRange(newText, newRule.startOffset, newRule.endOffset);
    const common = {
      styleSheet: sheetRef,
      selector: newRule.selector,
      ...(newRule.mediaText ? { mediaText: newRule.mediaText } : {}),
    };

    if (!oldRule) {
      // Brand-new rule. DevTools-typed rules land in the inspector sheet;
      // either way there is no old range to anchor to -> op:add-rule.
      const declText = [...newRule.decls]
        .map(([p, v]) => `${p}: ${v};`)
        .join(" ");
      changes.push({
        op: "add-rule",
        ...common,
        ruleText: `${newRule.selector} { ${declText} }`,
      });
      continue;
    }

    for (const [prop, newValue] of newRule.decls) {
      const oldValue = oldRule.decls.get(prop);
      if (oldValue === undefined) {
        changes.push({ op: "add-decl", ...common, range, property: prop, newValue });
      } else if (oldValue !== newValue) {
        changes.push({
          op: "modify",
          ...common,
          range,
          property: prop,
          oldValue,
          newValue,
        });
      }
    }
    for (const [prop] of oldRule.decls) {
      if (!newRule.decls.has(prop)) {
        changes.push({ op: "delete-decl", ...common, range, property: prop });
      }
    }
  }

  // Rules that vanished entirely: emit delete-decl per declaration.
  for (const [key, oldRule] of oldRules) {
    if (newRules.has(key)) continue;
    for (const [prop] of oldRule.decls) {
      changes.push({
        op: "delete-decl",
        styleSheet: sheetRef,
        selector: oldRule.selector,
        // Keep the media context so apply targets the right duplicate selector.
        ...(oldRule.mediaText ? { mediaText: oldRule.mediaText } : {}),
        property: prop,
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// DOM / Elements-panel change building
// ---------------------------------------------------------------------------

/**
 * Build an ElementContext from a CDP DOM.getAttributes-style flat array
 * (["name1","value1","name2","value2", ...]) plus the node's tag name (CDP
 * DOM.Node.nodeName, e.g. "DIV").
 */
export function elementContextFromAttributes(nodeName, attributesFlat) {
  const attrs = new Map();
  const flat = attributesFlat ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    attrs.set(flat[i], flat[i + 1]);
  }

  const context = {
    tagName: String(nodeName ?? "").toLowerCase(),
    classList: (attrs.get("class") ?? "").split(/\s+/).filter(Boolean),
  };

  const file = attrs.get(DATA_SOURCE_FILE);
  if (file) context.dataSourceFile = file;

  const lineRaw = attrs.get(DATA_SOURCE_LINE);
  const line = lineRaw !== undefined ? Number.parseInt(lineRaw, 10) : NaN;
  if (Number.isInteger(line) && line > 0) context.dataSourceLine = line;

  const component = attrs.get(DATA_SOURCE_COMPONENT);
  if (component) context.dataSourceComponent = component;

  return context;
}

/**
 * Build an ElementContext from a node's off-DOM source location — the
 * `__srcLoc` property attached by @css-sync/babel-plugin-source-locator's
 * runtime ref (read via inspectedWindow.eval `$0.__srcLoc` or CDP
 * Runtime.callFunctionOn). `srcLoc` is `{dataSourceFile, dataSourceLine,
 * dataSourceComponent?}` or null; `classList` is an array of class names.
 */
export function elementContextFromSrcLoc(nodeName, classList, srcLoc) {
  const context = {
    tagName: String(nodeName ?? "").toLowerCase(),
    classList: Array.isArray(classList) ? classList.filter(Boolean) : [],
  };

  if (srcLoc && typeof srcLoc === "object") {
    if (typeof srcLoc.dataSourceFile === "string" && srcLoc.dataSourceFile) {
      context.dataSourceFile = srcLoc.dataSourceFile;
    }
    const line = srcLoc.dataSourceLine;
    if (Number.isInteger(line) && line > 0) context.dataSourceLine = line;
    if (typeof srcLoc.dataSourceComponent === "string" && srcLoc.dataSourceComponent) {
      context.dataSourceComponent = srcLoc.dataSourceComponent;
    }
  }

  return context;
}

/**
 * True when `context` carries enough info to locate the element in source
 * (mirrors RequiredElementContextSchema in the contract: non-empty
 * dataSourceFile + positive-integer dataSourceLine).
 */
export function hasSourceLocation(context) {
  return (
    !!context &&
    typeof context.dataSourceFile === "string" &&
    context.dataSourceFile.length > 0 &&
    typeof context.dataSourceLine === "number" &&
    Number.isInteger(context.dataSourceLine) &&
    context.dataSourceLine > 0
  );
}

function skipNoSourceLocation(op, context) {
  const where = context && context.tagName ? `<${context.tagName}>` : "element";
  return {
    ok: false,
    reason:
      `Skipped ${op} on ${where}: no ${DATA_SOURCE_FILE}/${DATA_SOURCE_LINE} ` +
      `(element not instrumented — cannot be located in source)`,
  };
}

/**
 * Build a set-attr CaptureChange from a resolved ElementContext, or a skip
 * result when the element has no usable source location. Never throws.
 * @returns {{ok: true, change: object} | {ok: false, reason: string}}
 */
export function buildSetAttrChange(context, attribute, value) {
  if (!hasSourceLocation(context)) return skipNoSourceLocation("set-attr", context);
  return {
    ok: true,
    change: { op: "set-attr", element: context, attribute, value },
  };
}

/** Build a remove-attr CaptureChange, or a skip result. Never throws. */
export function buildRemoveAttrChange(context, attribute) {
  if (!hasSourceLocation(context)) return skipNoSourceLocation("remove-attr", context);
  return {
    ok: true,
    change: { op: "remove-attr", element: context, attribute },
  };
}

/** Build a set-text CaptureChange, or a skip result. Never throws. */
export function buildSetTextChange(context, newText, oldText) {
  if (!hasSourceLocation(context)) return skipNoSourceLocation("set-text", context);
  const change = { op: "set-text", element: context, newText };
  if (typeof oldText === "string") change.oldText = oldText;
  return { ok: true, change };
}

/** Build a set-text-segment CaptureChange, or a skip result. Never throws. */
export function buildSetTextSegmentChange(context, segmentIndex, oldText, newText) {
  if (!hasSourceLocation(context)) return skipNoSourceLocation("set-text-segment", context);
  return {
    ok: true,
    change: { op: "set-text-segment", element: context, segmentIndex, oldText, newText },
  };
}

// ---------------------------------------------------------------------------
// Text-segment resolution — map a live DOM text-node edit inside a MIXED
// element (static runs interleaved with {expr} holes / nested tags) back to the
// one static JSXText child it corresponds to, so we can emit a surgical
// set-text-segment instead of a whole-body set-text the server would refuse.
//
// The input `parts` come from the server /describe endpoint (TemplateResponse):
// the located element's source children in order, each tagged static / dynamic
// / element with its ORIGINAL child index. `kids` is the element's live DOM
// childNodes serialized as {t, v} (t: 0=text, 1=element, 2=other; v=text value).
//
// Everything here is pure + browser-free so diff.test.js can cover the fiddly
// JSX-whitespace edge cases without a real page.
// ---------------------------------------------------------------------------

/**
 * The source parts that produce exactly one live DOM node, in order. A static
 * JSXText child renders NOTHING iff it is whitespace-only AND contains a newline
 * (JSX strips source-indentation between lines); every other static run, and
 * every dynamic/element hole, is assumed to yield one node — an assumption the
 * caller VALIDATES by requiring the rendered count to equal the DOM child count
 * (a dynamic that renders 0 or N nodes, e.g. `{list.map(...)}`, trips the
 * mismatch and the whole edit is refused rather than mis-mapped).
 */
export function renderProducingParts(parts) {
  return parts.filter(
    (p) => !(p.kind === "static" && p.whitespaceOnly && p.text.indexOf("\n") !== -1),
  );
}

/**
 * Reverse JSX whitespace handling for a single static run so a new RENDERED text
 * value can be spliced back into source without eating the source indentation.
 * JSX drops leading/trailing whitespace runs that contain a newline (they are
 * pure source formatting) but keeps newline-free whitespace. We peel those
 * newline-bearing lead/trail runs off the raw JSXText, reconstruct
 * `lead + newRenderedText + trail`, and REFUSE when the remaining core still
 * holds an internal newline (multi-line static run — its collapse under JSX
 * rules isn't safely reversible).
 * @returns {{ok: true, newText: string} | {ok: false, reason: string}}
 */
export function reconstructRawSegment(rawPartText, newRenderedText) {
  const leadM = rawPartText.match(/^\s*\n\s*/);
  const lead = leadM ? leadM[0] : "";
  const rest = rawPartText.slice(lead.length);
  const trailM = rest.match(/\s*\n\s*$/);
  const trail = trailM ? trailM[0] : "";
  const middle = rest.slice(0, rest.length - trail.length);
  if (middle.indexOf("\n") !== -1) return { ok: false, reason: "multiline-static" };
  return { ok: true, newText: lead + newRenderedText + trail };
}

/**
 * Resolve a single live text-node edit to a set-text-segment payload, or a skip.
 * `changedIndex` is the index (into `kids`) of the text node whose value the
 * user edited to `newRenderedText`. Refuses (never guesses) when the DOM and the
 * source children don't line up 1:1, when the changed node maps to a dynamic
 * hole (editing rendered `{name}` must NOT rewrite the expression), or when the
 * static run is multi-line. Never throws.
 * @returns {{ok: true, segmentIndex: number, oldText: string, newText: string}
 *          | {ok: false, reason: string, dynamic?: boolean}}
 */
export function resolveTextSegmentEdit(parts, kids, changedIndex, newRenderedText) {
  if (!Array.isArray(parts) || !Array.isArray(kids)) return { ok: false, reason: "bad-input" };
  const rendered = renderProducingParts(parts);
  if (rendered.length !== kids.length) return { ok: false, reason: "count-mismatch" };
  // Structural integrity: a static part must sit over a text node, an element
  // part over an element node. A dynamic hole may render either — no constraint.
  for (let i = 0; i < rendered.length; i++) {
    const p = rendered[i];
    const k = kids[i];
    if (!k) return { ok: false, reason: "kid-missing" };
    if (p.kind === "static" && k.t !== 0) return { ok: false, reason: "misaligned" };
    if (p.kind === "element" && k.t !== 1) return { ok: false, reason: "misaligned" };
  }
  const part = rendered[changedIndex];
  const kid = kids[changedIndex];
  if (!part || !kid) return { ok: false, reason: "no-part" };
  if (kid.t !== 0) return { ok: false, reason: "changed-not-text" };
  if (part.kind !== "static") return { ok: false, reason: "dynamic", dynamic: true };
  const rc = reconstructRawSegment(part.text, newRenderedText);
  if (!rc.ok) return { ok: false, reason: rc.reason };
  return { ok: true, segmentIndex: part.index, oldText: part.text, newText: rc.newText };
}

// ---------------------------------------------------------------------------
// Inline-style promote: element.style edit -> generated class + overrides rule
// ---------------------------------------------------------------------------

/**
 * Deterministic class name for an element identified by its source location.
 * Stable per (file, line) so re-promoting the SAME element updates one rule in
 * place instead of piling up copies. djb2 hash -> base36 keeps the result
 * within the contract's `^csync-[0-9a-z]+$` charset (safe to embed both in a
 * JSX className string and as a CSS selector). MUST stay in sync with
 * PromotedClassNameSchema in packages/contract/src/index.ts.
 */
export function promotedClassName(file, line) {
  const s = `${file}:${line}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; // (h*33) ^ c, kept unsigned
  }
  return "csync-" + h.toString(36);
}

/**
 * Parse an element's inline `style.cssText` into an ordered array of
 * {property, value} declarations (last write wins per property, lowercased
 * property names). Reuses the same comment/string-aware declaration parser the
 * sheet diff uses. Returns [] for empty/blank cssText.
 */
export function parseInlineDeclarations(cssText) {
  const map = parseDeclarations(cssText || "");
  const out = [];
  for (const [property, value] of map) {
    if (property && value) out.push({ property, value });
  }
  return out;
}

/**
 * Build a promote-inline-style CaptureChange from a resolved ElementContext and
 * the element's current inline cssText, or a skip result when the element is
 * not locatable in source or carries no inline declarations. Never throws.
 * The full current inline declaration set is sent (not a delta): the server
 * replaces the generated class's body wholesale, so this is idempotent —
 * re-promoting the same cssText converges to the same rule.
 * @returns {{ok: true, change: object} | {ok: false, reason: string}}
 */
export function buildPromoteInlineStyleChange(context, cssText) {
  if (!hasSourceLocation(context)) return skipNoSourceLocation("promote-inline-style", context);
  const declarations = parseInlineDeclarations(cssText);
  if (declarations.length === 0) {
    return {
      ok: false,
      reason: `Skipped promote-inline-style on <${context.tagName}>: no inline declarations`,
    };
  }
  const className = promotedClassName(context.dataSourceFile, context.dataSourceLine);
  return {
    ok: true,
    change: { op: "promote-inline-style", element: context, className, declarations },
  };
}
