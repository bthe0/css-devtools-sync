// apply-sfc-markup.ts — shared markup tier for .vue / .svelte / .astro.
//
// applyJsxChange can't touch these: @babel/parser (jsx) doesn't understand an
// SFC template. But a STATIC attribute or text run in a Vue/Svelte/Astro
// template is byte-identical HTML, so one dependency-free, line-anchored
// byte-splice serves all three — no per-framework compiler in the server (the
// same precedent apply-sfc.ts set for the CSS-rule tier).
//
// Scope (v1): the element is located by its source LINE (the same line the
// build-time stamp records on `__srcLoc`), and we edit only STATIC markup:
//   - set-attr    : add/replace a plain quoted attribute (e.g. style="…")
//   - remove-attr : drop a plain attribute
//   - set-text    : replace the text of a text-only element
// Anything dynamic — a `:style`/`{expr}` binding, a mixed/element child, a
// dynamic `<svelte:element>` — is refused with a clear reason rather than
// risking a corrupt template. set-text-segment is not supported yet.
import fs from "node:fs";
import type {
  RemoveAttrChange,
  SetAttrChange,
  SetTextChange,
} from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { jailResolve } from "./workspace.js";

export type SfcMarkupChange = SetAttrChange | RemoveAttrChange | SetTextChange;

/** Elements that never have a text body — set-text is meaningless on them. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape a string for use as a double-quoted HTML attribute value. */
function escAttrValue(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Escape a string for use as HTML text content. */
function escText(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** 0-based [start, end) char offsets of a 1-based source line (end excludes the newline). */
function lineOffsets(source: string, line: number): { start: number; end: number } | null {
  if (line <= 0) return null;
  let start = 0;
  for (let n = 1; n < line; n++) {
    const nl = source.indexOf("\n", start);
    if (nl === -1) return null;
    start = nl + 1;
  }
  const nl = source.indexOf("\n", start);
  return { start, end: nl === -1 ? source.length : nl };
}

interface OpenTag {
  tagStart: number; // index of '<'
  nameEnd: number; // index just past the tag name
  gtIndex: number; // index of the closing '>'
  tagName: string;
  selfClosing: boolean;
}

/** Parse the element open tag beginning at `ltIndex` (source[ltIndex] === '<'). */
function parseOpenTag(source: string, ltIndex: number): OpenTag | null {
  if (source[ltIndex] !== "<") return null;
  const nameMatch = /^[a-zA-Z][\w:-]*/.exec(source.slice(ltIndex + 1));
  if (!nameMatch) return null;
  const tagName = nameMatch[0];
  let i = ltIndex + 1 + tagName.length;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      const selfClosing = source[i - 1] === "/";
      return { tagStart: ltIndex, nameEnd: ltIndex + 1 + tagName.length, gtIndex: i, tagName, selfClosing };
    }
    i++;
  }
  return null; // unterminated tag
}

/** Find the first element open tag whose '<' sits on `targetLine`. */
function locateOpenTag(source: string, targetLine: number): OpenTag {
  const range = lineOffsets(source, targetLine);
  if (!range) {
    throw new SkipChangeError(`line ${String(targetLine)} is out of range in the SFC source`);
  }
  const re = /<[a-zA-Z]/g;
  re.lastIndex = range.start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m.index >= range.end) break;
    const open = parseOpenTag(source, m.index);
    if (open) return open;
  }
  throw new SkipChangeError(
    `no element open tag found on line ${String(targetLine)} — the source may have drifted since it was stamped`,
  );
}

/** Byte range of the matching close tag for a non-void element, honoring same-tag nesting. */
function findCloseTag(source: string, from: number, tagName: string): { start: number; end: number } {
  const re = new RegExp("<(/?)" + escRe(tagName) + "(?=[\\s/>])", "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] === "/") {
      depth--;
      if (depth === 0) {
        const gt = source.indexOf(">", m.index);
        if (gt === -1) break;
        return { start: m.index, end: gt + 1 };
      }
    } else {
      const open = parseOpenTag(source, m.index);
      if (open && !open.selfClosing) depth++;
      if (open) re.lastIndex = open.gtIndex + 1;
    }
  }
  throw new SkipChangeError(`could not find the closing </${tagName}> tag to bound the text edit`);
}

function applySetAttr(source: string, open: OpenTag, change: SetAttrChange): string {
  const attr = change.attribute;
  // The class tier owns class edits; a raw class="" here would fight it.
  if (attr === "class" || attr === "className") {
    throw new SkipChangeError(
      `refusing to set "${attr}" directly; class edits are handled by the class-list tier`,
    );
  }
  const tagEnd = open.selfClosing ? open.gtIndex - 1 : open.gtIndex;
  const openStr = source.slice(open.tagStart, tagEnd); // '<tag …' up to (but not incl.) '>' or '/'
  const rel = open.nameEnd - open.tagStart; // offset of first attr slot within openStr

  // Reject a dynamic binding of the same attribute (Vue :attr / v-bind, Svelte
  // attr={expr}, Astro attr={expr}) — editing those would clobber code.
  const dynRe = new RegExp("\\s(?::|v-bind:)?" + escRe(attr) + "\\s*=\\s*\\{");
  const boundRe = new RegExp("\\s(?::|v-bind:)" + escRe(attr) + "\\b");
  if (dynRe.test(openStr) || boundRe.test(openStr)) {
    throw new SkipChangeError(
      `"${attr}" is a dynamic binding on this element; cannot edit deterministically`,
    );
  }

  const quotedRe = new RegExp("(\\s" + escRe(attr) + "\\s*=\\s*)(['\"])([\\s\\S]*?)\\2");
  const qm = quotedRe.exec(openStr);
  if (qm) {
    const quote = qm[2]!;
    const escaped = quote === '"' ? escAttrValue(change.value) : change.value.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
    const start = qm.index + qm[1]!.length + 1; // just past the opening quote
    const end = start + qm[3]!.length;
    const newOpen = openStr.slice(0, start) + escaped + openStr.slice(end);
    return source.slice(0, open.tagStart) + newOpen + source.slice(tagEnd);
  }

  // No existing attribute — insert a new one right after the tag name.
  const insert = ` ${attr}="${escAttrValue(change.value)}"`;
  const newOpen = openStr.slice(0, rel) + insert + openStr.slice(rel);
  return source.slice(0, open.tagStart) + newOpen + source.slice(tagEnd);
}

function applyRemoveAttr(source: string, open: OpenTag, change: RemoveAttrChange): string {
  const attr = change.attribute;
  const tagEnd = open.selfClosing ? open.gtIndex - 1 : open.gtIndex;
  const openStr = source.slice(open.tagStart, tagEnd);
  // Remove `attr="…"`, `attr='…'`, unquoted `attr=…`, or a bare `attr`, with its leading whitespace.
  const re = new RegExp("\\s" + escRe(attr) + "(?:\\s*=\\s*(?:(['\"])[\\s\\S]*?\\1|[^\\s>]+))?(?=[\\s/>]|$)");
  const m = re.exec(openStr);
  if (!m) {
    throw new SkipChangeError(`attribute "${attr}" is not present on the element at that line`);
  }
  const newOpen = openStr.slice(0, m.index) + openStr.slice(m.index + m[0].length);
  return source.slice(0, open.tagStart) + newOpen + source.slice(tagEnd);
}

function applySetText(source: string, open: OpenTag, change: SetTextChange): string {
  if (open.selfClosing || VOID_ELEMENTS.has(open.tagName.toLowerCase())) {
    throw new SkipChangeError(`<${open.tagName}> has no text content to edit`);
  }
  const innerStart = open.gtIndex + 1;
  const close = findCloseTag(source, innerStart, open.tagName);
  const inner = source.slice(innerStart, close.start);
  // Refuse anything but a single static text run: a nested tag (`<`) or an
  // interpolation hole (`{…}`) means flattening would destroy dynamic content.
  if (inner.includes("<") || inner.includes("{")) {
    throw new SkipChangeError(
      "element has non-text or dynamic children; whole-body text edits are refused (edit the segment in source)",
    );
  }
  if (change.oldText != null && inner.trim() !== change.oldText.trim()) {
    throw new SkipChangeError(
      `source text drifted: expected "${change.oldText.trim()}" but found "${inner.trim()}"`,
    );
  }
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner)![0];
  const newInner = lead + escText(change.newText) + trail;
  return source.slice(0, innerStart) + newInner + source.slice(close.start);
}

/**
 * Pure, string-in/string-out core: apply one markup change to SFC template
 * source. Locates the element by `change.element.dataSourceLine` (override with
 * `opts.line`) and returns the rewritten source. Throws SkipChangeError with a
 * human reason on anything it refuses to touch.
 */
export function applySfcMarkup(
  source: string,
  change: SfcMarkupChange,
  opts: { line?: number } = {},
): string {
  const line = opts.line ?? change.element.dataSourceLine;
  const open = locateOpenTag(source, line);
  switch (change.op) {
    case "set-attr":
      return applySetAttr(source, open, change);
    case "remove-attr":
      return applyRemoveAttr(source, open, change);
    case "set-text":
      return applySetText(source, open, change);
  }
}

export interface SfcMarkupApplyResult {
  file: string;
  before: string;
  after: string;
  line: number;
}

/**
 * Read the stamped SFC source (jailed under workspaceRoot), compute the markup
 * edit WITHOUT writing, and return before/after for the caller to preview or
 * commit — mirrors applyJsxChange's contract so apply.ts routes both the same.
 */
export function applySfcMarkupChange(
  workspaceRoot: string,
  change: SfcMarkupChange,
): SfcMarkupApplyResult {
  const rel = change.element.dataSourceFile;
  const abs = jailResolve(workspaceRoot, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new SkipChangeError(`instrumented source file not found: ${rel}`);
  }
  const before = fs.readFileSync(abs, "utf8");
  const after = applySfcMarkup(before, change);
  return { file: abs, before, after, line: change.element.dataSourceLine };
}
